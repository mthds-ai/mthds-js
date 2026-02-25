import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { SemVer } from "semver";
import { DependencyResolveError, ManifestError, TransitiveDependencyError } from "./exceptions.js";
import type { ParsedManifest, PackageDependency } from "./manifest/schema.js";
import { parseMethodsToml } from "./manifest/parser.js";
import { MANIFEST_FILENAME } from "./discovery.js";
import { getCachedPackagePath, isCached, storeInCache } from "./package-cache.js";
import { parseConstraint, parseVersion, selectMinimumVersionForMultipleConstraints, versionSatisfies } from "./semver.js";
import { addressToCloneUrl, cloneAtVersion, listRemoteVersionTags, resolveVersionFromTags } from "./vcs-resolver.js";
import type { VCSFetchError, VersionResolutionError, PackageCacheError } from "./exceptions.js";

export interface ResolvedDependency {
  readonly alias: string;
  readonly address: string;
  readonly manifest: ParsedManifest | null;
  readonly packageRoot: string;
  readonly mthdsFiles: string[];
  readonly exportedPipeCodes: Set<string> | null;
}

/**
 * Collect all .mthds files under a directory recursively.
 */
export function collectMthdsFiles(directory: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".mthds")) {
        results.push(fullPath);
      }
    }
  }
  walk(directory);
  return results.sort();
}

/**
 * Determine which pipes are exported by a dependency.
 * Returns null when all pipes should be public.
 */
export function determineExportedPipes(manifest: ParsedManifest | null): Set<string> | null {
  if (manifest === null) return null;
  if (Object.keys(manifest.exports).length === 0) return null;

  const exported = new Set<string>();
  for (const domainExport of Object.values(manifest.exports)) {
    for (const pipe of domainExport.pipes) {
      exported.add(pipe);
    }
  }
  return exported;
}

function findManifestInDir(directory: string): ParsedManifest | null {
  const manifestPath = join(directory, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    return parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestError) return null;
    throw err;
  }
}

function resolveLocalDependency(
  alias: string,
  dep: PackageDependency,
  packageRoot: string,
): ResolvedDependency {
  const depDir = resolve(packageRoot, dep.path!);
  if (!existsSync(depDir)) {
    throw new DependencyResolveError(
      `Dependency '${alias}' local path '${dep.path}' resolves to '${depDir}' which does not exist`,
    );
  }
  if (!statSync(depDir).isDirectory()) {
    throw new DependencyResolveError(
      `Dependency '${alias}' local path '${dep.path}' resolves to '${depDir}' which is not a directory`,
    );
  }

  const depManifest = findManifestInDir(depDir);
  const mthdsFiles = collectMthdsFiles(depDir);
  const exportedPipeCodes = determineExportedPipes(depManifest);

  return { alias, address: dep.address, manifest: depManifest, packageRoot: depDir, mthdsFiles, exportedPipeCodes };
}

async function resolveRemoteDependency(
  alias: string,
  dep: PackageDependency,
  cacheRoot?: string,
  fetchUrlOverride?: string,
): Promise<ResolvedDependency> {
  const cloneUrl = fetchUrlOverride ?? addressToCloneUrl(dep.address);

  let versionTags: Array<[SemVer, string]>;
  let selectedVersion: SemVer;
  let selectedTag: string;
  try {
    versionTags = await listRemoteVersionTags(cloneUrl);
    [selectedVersion, selectedTag] = resolveVersionFromTags(versionTags, dep.version);
  } catch (err) {
    throw new DependencyResolveError(
      `Failed to resolve remote dependency '${alias}' (${dep.address}): ${(err as Error).message}`,
    );
  }

  const versionStr = selectedVersion.version;

  // Check cache
  if (isCached(dep.address, versionStr, cacheRoot)) {
    const cachedPath = getCachedPackagePath(dep.address, versionStr, cacheRoot);
    return buildResolvedFromDir(alias, dep.address, cachedPath);
  }

  // Clone and cache
  const tmpDir = mkdtempSync(join(tmpdir(), "mthds_clone_"));
  try {
    const cloneDest = join(tmpDir, "pkg");
    await cloneAtVersion(cloneUrl, selectedTag, cloneDest);
    const cachedPath = storeInCache(cloneDest, dep.address, versionStr, cacheRoot);
    return buildResolvedFromDir(alias, dep.address, cachedPath);
  } catch (err) {
    throw new DependencyResolveError(
      `Failed to fetch/cache dependency '${alias}' (${dep.address}@${versionStr}): ${(err as Error).message}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildResolvedFromDir(alias: string, address: string, directory: string): ResolvedDependency {
  const depManifest = findManifestInDir(directory);
  const mthdsFiles = collectMthdsFiles(directory);
  const exportedPipeCodes = determineExportedPipes(depManifest);

  return { alias, address, manifest: depManifest, packageRoot: directory, mthdsFiles, exportedPipeCodes };
}

async function resolveWithMultipleConstraints(
  address: string,
  alias: string,
  constraints: string[],
  tagsCache: Map<string, Array<[SemVer, string]>>,
  cacheRoot?: string,
  fetchUrlOverride?: string,
): Promise<ResolvedDependency> {
  const cloneUrl = fetchUrlOverride ?? addressToCloneUrl(address);

  // Get or cache tag list
  if (!tagsCache.has(address)) {
    try {
      tagsCache.set(address, await listRemoteVersionTags(cloneUrl));
    } catch (err) {
      throw new DependencyResolveError(`Failed to list tags for '${address}': ${(err as Error).message}`);
    }
  }

  const versionTags = tagsCache.get(address)!;
  const versions = versionTags.map((entry) => entry[0]);

  // Parse all constraints and find a version satisfying all
  const parsedConstraints = constraints.map((constraint) => parseConstraint(constraint));
  const selected = selectMinimumVersionForMultipleConstraints(versions, parsedConstraints);

  if (selected === null) {
    throw new TransitiveDependencyError(
      `No version of '${address}' satisfies all constraints: ${constraints.join(", ")}`,
    );
  }

  const versionStr = selected.version;

  // Check cache
  if (isCached(address, versionStr, cacheRoot)) {
    const cachedPath = getCachedPackagePath(address, versionStr, cacheRoot);
    return buildResolvedFromDir(alias, address, cachedPath);
  }

  // Find the corresponding tag name
  let selectedTag: string | undefined;
  for (const [ver, tagName] of versionTags) {
    if (ver.compare(selected) === 0) {
      selectedTag = tagName;
      break;
    }
  }

  if (!selectedTag) {
    throw new DependencyResolveError(
      `Internal error: selected version ${selected.version} not found in tag list for '${address}'`,
    );
  }

  // Clone and cache
  const tmpDir = mkdtempSync(join(tmpdir(), "mthds_clone_"));
  try {
    const cloneDest = join(tmpDir, "pkg");
    await cloneAtVersion(cloneUrl, selectedTag, cloneDest);
    const cachedPath = storeInCache(cloneDest, address, versionStr, cacheRoot);
    return buildResolvedFromDir(alias, address, cachedPath);
  } catch (err) {
    throw new DependencyResolveError(
      `Failed to fetch/cache '${address}@${versionStr}': ${(err as Error).message}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function removeStaleSubdepConstraints(
  oldManifest: ParsedManifest | null,
  resolvedMap: Map<string, ResolvedDependency>,
  constraintsByAddress: Map<string, string[]>,
): void {
  if (!oldManifest || Object.keys(oldManifest.dependencies).length === 0) return;

  for (const oldSub of Object.values(oldManifest.dependencies)) {
    if (oldSub.path !== undefined) continue;
    const constraintsList = constraintsByAddress.get(oldSub.address);
    if (!constraintsList) continue;

    const idx = constraintsList.indexOf(oldSub.version);
    if (idx === -1) continue;
    constraintsList.splice(idx, 1);

    if (constraintsList.length === 0) {
      constraintsByAddress.delete(oldSub.address);
      const oldResolvedSub = resolvedMap.get(oldSub.address);
      if (oldResolvedSub) {
        resolvedMap.delete(oldSub.address);
        removeStaleSubdepConstraints(oldResolvedSub.manifest, resolvedMap, constraintsByAddress);
      }
    }
  }
}

async function resolveTransitiveTree(
  deps: Record<string, PackageDependency>,
  resolutionStack: Set<string>,
  resolvedMap: Map<string, ResolvedDependency>,
  constraintsByAddress: Map<string, string[]>,
  tagsCache: Map<string, Array<[SemVer, string]>>,
  cacheRoot?: string,
  fetchUrlOverrides?: Record<string, string>,
): Promise<void> {
  for (const [alias, dep] of Object.entries(deps)) {
    // Skip local path deps in transitive resolution
    if (dep.path !== undefined) continue;

    // Cycle detection
    if (resolutionStack.has(dep.address)) {
      throw new TransitiveDependencyError(
        `Dependency cycle detected: '${dep.address}' is already on the resolution stack`,
      );
    }

    // Track constraint
    if (!constraintsByAddress.has(dep.address)) {
      constraintsByAddress.set(dep.address, []);
    }
    constraintsByAddress.get(dep.address)!.push(dep.version);

    // Already resolved — check if existing version satisfies new constraint
    if (resolvedMap.has(dep.address)) {
      const existing = resolvedMap.get(dep.address)!;
      if (existing.manifest !== null) {
        const existingConstraint = parseConstraint(dep.version);
        const existingVer = parseVersion(existing.manifest.version);
        if (versionSatisfies(existingVer, existingConstraint)) {
          continue;
        }
      }

      // Diamond: remove stale constraints from old version's sub-deps
      removeStaleSubdepConstraints(existing.manifest, resolvedMap, constraintsByAddress);

      // Diamond: re-resolve with all constraints
      const overrideUrl = fetchUrlOverrides?.[dep.address];
      const reResolved = await resolveWithMultipleConstraints(
        dep.address, alias,
        constraintsByAddress.get(dep.address)!,
        tagsCache, cacheRoot, overrideUrl,
      );
      resolvedMap.set(dep.address, reResolved);

      // Recurse into sub-dependencies of the re-resolved version
      if (reResolved.manifest && Object.keys(reResolved.manifest.dependencies).length > 0) {
        const remoteSubs: Record<string, PackageDependency> = {};
        for (const [subAlias, sub] of Object.entries(reResolved.manifest.dependencies)) {
          if (sub.path === undefined) remoteSubs[subAlias] = sub;
        }
        if (Object.keys(remoteSubs).length > 0) {
          resolutionStack.add(dep.address);
          try {
            await resolveTransitiveTree(
              remoteSubs, resolutionStack, resolvedMap,
              constraintsByAddress, tagsCache, cacheRoot, fetchUrlOverrides,
            );
          } finally {
            resolutionStack.delete(dep.address);
          }
        }
      }
      continue;
    }

    // Normal resolve
    resolutionStack.add(dep.address);
    try {
      const overrideUrl = fetchUrlOverrides?.[dep.address];
      let resolvedDep: ResolvedDependency;

      if (constraintsByAddress.get(dep.address)!.length > 1) {
        resolvedDep = await resolveWithMultipleConstraints(
          dep.address, alias,
          constraintsByAddress.get(dep.address)!,
          tagsCache, cacheRoot, overrideUrl,
        );
      } else {
        resolvedDep = await resolveRemoteDependency(alias, dep, cacheRoot, overrideUrl);
      }

      resolvedMap.set(dep.address, resolvedDep);

      // Recurse into sub-dependencies (remote only)
      if (resolvedDep.manifest && Object.keys(resolvedDep.manifest.dependencies).length > 0) {
        const remoteSubs: Record<string, PackageDependency> = {};
        for (const [subAlias, sub] of Object.entries(resolvedDep.manifest.dependencies)) {
          if (sub.path === undefined) remoteSubs[subAlias] = sub;
        }
        if (Object.keys(remoteSubs).length > 0) {
          await resolveTransitiveTree(
            remoteSubs, resolutionStack, resolvedMap,
            constraintsByAddress, tagsCache, cacheRoot, fetchUrlOverrides,
          );
        }
      }
    } finally {
      resolutionStack.delete(dep.address);
    }
  }
}

/**
 * Resolve all dependencies with transitive resolution for remote deps.
 *
 * Local path dependencies are resolved directly (no recursion into their sub-deps).
 * Remote dependencies are resolved transitively with cycle detection and diamond
 * constraint handling.
 */
export async function resolveAllDependencies(
  manifest: ParsedManifest,
  packageRoot: string,
  cacheRoot?: string,
  fetchUrlOverrides?: Record<string, string>,
): Promise<ResolvedDependency[]> {
  // 1. Resolve local path deps (direct only, no recursion)
  const localResolved: ResolvedDependency[] = [];
  const remoteDeps: Record<string, PackageDependency> = {};

  for (const [alias, dep] of Object.entries(manifest.dependencies)) {
    if (dep.path !== undefined) {
      localResolved.push(resolveLocalDependency(alias, dep, packageRoot));
    } else {
      remoteDeps[alias] = dep;
    }
  }

  // 2. Resolve remote deps transitively
  const resolvedMap = new Map<string, ResolvedDependency>();
  const constraintsByAddress = new Map<string, string[]>();
  const tagsCache = new Map<string, Array<[SemVer, string]>>();
  const resolutionStack = new Set<string>();

  if (Object.keys(remoteDeps).length > 0) {
    await resolveTransitiveTree(
      remoteDeps, resolutionStack, resolvedMap,
      constraintsByAddress, tagsCache, cacheRoot, fetchUrlOverrides,
    );
  }

  return [...localResolved, ...resolvedMap.values()];
}
