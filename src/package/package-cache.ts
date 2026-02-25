import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PackageCacheError } from "./exceptions.js";

/**
 * Return the default cache root directory: ~/.mthds/packages
 */
export function getDefaultCacheRoot(): string {
  return join(homedir(), ".mthds", "packages");
}

/**
 * Compute the cache path for a package version.
 * Includes path traversal protection.
 */
export function getCachedPackagePath(
  address: string,
  version: string,
  cacheRoot?: string,
): string {
  const root = resolve(cacheRoot ?? getDefaultCacheRoot());
  const resolved = resolve(root, address, version);
  if (!resolved.startsWith(root + sep)) {
    throw new PackageCacheError(
      `Path traversal detected: address '${address}' and version '${version}' resolve outside cache root`,
    );
  }
  return resolved;
}

/**
 * Check whether a package version exists in the cache.
 * A directory is considered cached if it exists and is non-empty.
 */
export function isCached(
  address: string,
  version: string,
  cacheRoot?: string,
): boolean {
  const pkgPath = getCachedPackagePath(address, version, cacheRoot);
  if (!existsSync(pkgPath)) return false;
  try {
    const entries = readdirSync(pkgPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Copy a package directory into the cache.
 * Uses a staging directory + rename for safe writes. Removes .git/ from the cached copy.
 */
export function storeInCache(
  sourceDir: string,
  address: string,
  version: string,
  cacheRoot?: string,
): string {
  const finalPath = getCachedPackagePath(address, version, cacheRoot);
  const stagingPath = `${finalPath}.staging`;

  try {
    // Ensure parent directory exists before any file operations
    const parentDir = resolve(finalPath, "..");
    mkdirSync(parentDir, { recursive: true });

    // Clean up any leftover staging dir
    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
    }

    // Copy source into staging
    cpSync(sourceDir, stagingPath, { recursive: true });

    // Remove .git/ from the staged copy
    const gitDir = join(stagingPath, ".git");
    if (existsSync(gitDir)) {
      rmSync(gitDir, { recursive: true, force: true });
    }

    // Atomic rename into final location
    if (existsSync(finalPath)) {
      rmSync(finalPath, { recursive: true, force: true });
    }
    renameSync(stagingPath, finalPath);
  } catch (err) {
    // Clean up staging on failure
    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { recursive: true, force: true });
    }
    throw new PackageCacheError(
      `Failed to store package '${address}@${version}' in cache: ${(err as Error).message}`,
    );
  }

  return finalPath;
}

/**
 * Remove a cached package version.
 * Returns true if the directory existed and was removed.
 */
export function removeCachedPackage(
  address: string,
  version: string,
  cacheRoot?: string,
): boolean {
  const pkgPath = getCachedPackagePath(address, version, cacheRoot);
  if (!existsSync(pkgPath)) return false;
  try {
    rmSync(pkgPath, { recursive: true, force: true });
  } catch (err) {
    throw new PackageCacheError(
      `Failed to remove cached package '${address}@${version}' at '${pkgPath}': ${(err as Error).message}`,
    );
  }
  return true;
}
