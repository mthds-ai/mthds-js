import { existsSync, statSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { TREE_DIGEST_PATTERN } from "../method-tree/digest.js";
import { listMethodTree } from "../method-tree/lister.js";
import { IntegrityError, LockFileError } from "./exceptions.js";
import { isValidSemver, type ParsedManifest } from "./manifest/schema.js";
import { getCachedPackagePath } from "./package-cache.js";

export const LOCK_FILENAME = "methods.lock";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface LockedPackage {
  readonly version: string;
  /** The tree digest of the package's tree (mthds/docs/spec/method-tree.md, "The Tree Digest"). */
  readonly digest: string;
  readonly source: string;
}

export interface LockFile {
  readonly packages: Record<string, LockedPackage>;
}

// ---------------------------------------------------------------------------
// Tree digest
// ---------------------------------------------------------------------------

/**
 * The tree digest of the package rooted at `directory`: its method tree, listed under the
 * membership rule with the directory as its root, whatever lies above it.
 */
export async function computePackageDigest(directory: string): Promise<string> {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new LockFileError(`Directory '${directory}' does not exist or is not a directory`);
  }
  return (await listMethodTree(directory, { discover: false })).digest;
}

// ---------------------------------------------------------------------------
// TOML parse / serialize
// ---------------------------------------------------------------------------

function validateLockedPackage(address: string, entry: Record<string, unknown>): LockedPackage {
  // A lock written before standard 7.0.0 records a `hash`, computed by an algorithm two different
  // directories could share; it is refused, never verified (mthds/docs/spec/lock-format.md). The
  // message names `lock` as the standard does: this package has no lock command of its own.
  if ("hash" in entry) {
    throw new LockFileError(
      `The lock entry for '${address}' records a 'hash', so this lock predates tree digests (MTHDS standard 7.0.0) and cannot be verified; run 'lock' to regenerate it.`,
    );
  }

  const version = entry["version"];
  if (typeof version !== "string" || !isValidSemver(version)) {
    throw new LockFileError(`Invalid version '${version}' for '${address}' in lock file`);
  }

  const digest = entry["digest"];
  if (typeof digest !== "string" || !TREE_DIGEST_PATTERN.test(digest)) {
    throw new LockFileError(`Invalid digest for '${address}' in lock file`);
  }

  const source = entry["source"];
  if (typeof source !== "string" || !source.startsWith("https://")) {
    throw new LockFileError(`Invalid source '${source}' for '${address}' in lock file`);
  }

  return { version, digest, source };
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
      digest: locked.digest,
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

export async function generateLockFile(resolvedDeps: ResolvedDepForLock[]): Promise<LockFile> {
  const packages: Record<string, LockedPackage> = {};

  for (const resolved of resolvedDeps) {
    if (resolved.manifest === null) {
      throw new LockFileError(
        `Remote dependency '${resolved.alias}' (${resolved.address}) has no manifest — cannot generate lock entry`,
      );
    }

    const address = resolved.address;
    const version = resolved.manifest.version;
    const digest = await computePackageDigest(resolved.packageRoot);
    const source = `https://${address}`;

    packages[address] = { version, digest, source };
  }

  return { packages };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Check a cached package against its lock entry's digest. The cache holds a copy of the fetched
 * checkout with its `.git` removed rather than a tree written out, so its digest is that of the
 * tree the membership rule lists from it, the same reading the lock was generated with.
 */
export async function verifyLockedPackage(
  locked: LockedPackage,
  address: string,
  cacheRoot?: string,
): Promise<void> {
  const cachedPath = getCachedPackagePath(address, locked.version, cacheRoot);

  if (!existsSync(cachedPath) || !statSync(cachedPath).isDirectory()) {
    throw new IntegrityError(
      `Cached package '${address}@${locked.version}' not found at '${cachedPath}'`,
    );
  }

  const actualDigest = await computePackageDigest(cachedPath);
  if (actualDigest !== locked.digest) {
    throw new IntegrityError(
      `Integrity check failed for '${address}@${locked.version}': expected ${locked.digest}, got ${actualDigest}`,
    );
  }
}

export async function verifyLockFile(lockFile: LockFile, cacheRoot?: string): Promise<void> {
  for (const [address, locked] of Object.entries(lockFile.packages)) {
    await verifyLockedPackage(locked, address, cacheRoot);
  }
}
