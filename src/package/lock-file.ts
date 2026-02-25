import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { parse, stringify } from "smol-toml";
import { IntegrityError, LockFileError } from "./exceptions.js";
import { isValidSemver, type ParsedManifest } from "./manifest/schema.js";
import { getCachedPackagePath } from "./package-cache.js";

export const LOCK_FILENAME = "methods.lock";
export const HASH_PREFIX = "sha256:";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface LockedPackage {
  readonly version: string;
  readonly hash: string;
  readonly source: string;
}

export interface LockFile {
  readonly packages: Record<string, LockedPackage>;
}

// ---------------------------------------------------------------------------
// Hash computation
// ---------------------------------------------------------------------------

function collectFilesRecursive(dir: string, baseDir: string, result: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);
    const posixRelPath = relPath.split("/").join(posix.sep);

    // Skip .git
    if (posixRelPath.split(posix.sep).includes(".git")) continue;

    if (entry.isFile()) {
      result.push(fullPath);
    } else if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, baseDir, result);
    }
  }
}

/**
 * Compute a deterministic SHA-256 hash of a directory's contents.
 * Sorts by POSIX-normalized relative path for cross-platform determinism.
 */
export function computeDirectoryHash(directory: string): string {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new LockFileError(`Directory '${directory}' does not exist or is not a directory`);
  }

  const hasher = createHash("sha256");
  const filePaths: string[] = [];
  collectFilesRecursive(directory, directory, filePaths);

  // Sort by POSIX relative path
  filePaths.sort((a, b) => {
    const relA = relative(directory, a).split("/").join(posix.sep);
    const relB = relative(directory, b).split("/").join(posix.sep);
    return relA.localeCompare(relB);
  });

  for (const filePath of filePaths) {
    const relativePosix = relative(directory, filePath).split("/").join(posix.sep);
    hasher.update(relativePosix, "utf-8");
    hasher.update(readFileSync(filePath));
  }

  return `${HASH_PREFIX}${hasher.digest("hex")}`;
}

// ---------------------------------------------------------------------------
// TOML parse / serialize
// ---------------------------------------------------------------------------

function validateLockedPackage(address: string, entry: Record<string, unknown>): LockedPackage {
  const version = entry["version"];
  if (typeof version !== "string" || !isValidSemver(version)) {
    throw new LockFileError(`Invalid version '${version}' for '${address}' in lock file`);
  }

  const hash = entry["hash"];
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    throw new LockFileError(`Invalid hash for '${address}' in lock file`);
  }

  const source = entry["source"];
  if (typeof source !== "string" || !source.startsWith("https://")) {
    throw new LockFileError(`Invalid source '${source}' for '${address}' in lock file`);
  }

  return { version, hash, source };
}

export function parseLockFile(content: string): LockFile {
  if (!content.trim()) {
    return { packages: {} };
  }

  let raw: Record<string, unknown>;
  try {
    raw = parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new LockFileError(`Invalid TOML syntax in lock file: ${(err as Error).message}`);
  }

  const packages: Record<string, LockedPackage> = {};
  for (const [address, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LockFileError(
        `Lock file entry for '${address}' must be a table, got ${typeof entry}`,
      );
    }
    packages[address] = validateLockedPackage(address, entry as Record<string, unknown>);
  }

  return { packages };
}

export function serializeLockFile(lockFile: LockFile): string {
  const doc: Record<string, Record<string, string>> = {};
  for (const address of Object.keys(lockFile.packages).sort()) {
    const locked = lockFile.packages[address]!;
    doc[address] = {
      version: locked.version,
      hash: locked.hash,
      source: locked.source,
    };
  }
  return stringify(doc);
}

// ---------------------------------------------------------------------------
// Lock file generation
// ---------------------------------------------------------------------------

export interface ResolvedDepForLock {
  readonly alias: string;
  readonly address: string;
  readonly manifest: ParsedManifest | null;
  readonly packageRoot: string;
}

export function generateLockFile(
  manifest: ParsedManifest,
  resolvedDeps: ResolvedDepForLock[],
): LockFile {
  const packages: Record<string, LockedPackage> = {};

  // Build set of local-override addresses from root manifest
  const localAddresses = new Set(
    Object.values((manifest as any).dependencies ?? {})
      .filter((dep: any) => dep.path !== undefined)
      .map((dep: any) => dep.address),
  );

  for (const resolved of resolvedDeps) {
    if (localAddresses.has(resolved.address)) continue;

    if (resolved.manifest === null) {
      throw new LockFileError(
        `Remote dependency '${resolved.alias}' (${resolved.address}) has no manifest — cannot generate lock entry`,
      );
    }

    const address = resolved.address;
    const version = resolved.manifest.version;
    const hash = computeDirectoryHash(resolved.packageRoot);
    const source = `https://${address}`;

    packages[address] = { version, hash, source };
  }

  return { packages };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function verifyLockedPackage(
  locked: LockedPackage,
  address: string,
  cacheRoot?: string,
): void {
  const cachedPath = getCachedPackagePath(address, locked.version, cacheRoot);

  if (!existsSync(cachedPath) || !statSync(cachedPath).isDirectory()) {
    throw new IntegrityError(
      `Cached package '${address}@${locked.version}' not found at '${cachedPath}'`,
    );
  }

  const actualHash = computeDirectoryHash(cachedPath);
  if (actualHash !== locked.hash) {
    throw new IntegrityError(
      `Integrity check failed for '${address}@${locked.version}': expected ${locked.hash}, got ${actualHash}`,
    );
  }
}

export function verifyLockFile(lockFile: LockFile, cacheRoot?: string): void {
  for (const [address, locked] of Object.entries(lockFile.packages)) {
    verifyLockedPackage(locked, address, cacheRoot);
  }
}
