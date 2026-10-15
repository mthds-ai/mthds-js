/**
 * Manifest Discovery (mthds/docs/spec/manifest-format.md, "Manifest Discovery"): the root of a
 * method's tree is the nearest directory at or above the one handed over that holds
 * `METHODS.toml`, the walk stopping at a directory holding an entry named `.git` of any kind, or at
 * the file system's root.
 */

import { lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { entryKindOf, GIT_ENTRY_NAME, MANIFEST_NAME, type EntryKind } from "./membership.js";

/**
 * The kind of the entry named exactly `name` in `directory`, never following a link, or `null`
 * when the directory holds no entry of that name. A case-insensitive file system answers `lstat`
 * for `methods.toml` when asked for `METHODS.toml`, so a hit is confirmed against the directory's
 * own listing; when the directory cannot be listed, the `lstat` answer stands.
 */
export function exactEntryKind(directory: string, name: string): EntryKind | null {
  let stats: Stats;
  try {
    stats = lstatSync(join(directory, name));
  } catch {
    return null;
  }
  try {
    if (!readdirSync(directory).includes(name)) return null;
  } catch {
    // An unreadable directory: keep what lstat found.
  }
  return entryKindOf(stats);
}

/**
 * The directory holding the manifest of the method `startDirectory` belongs to, or `null` when the
 * walk up from it finds none. `startDirectory` is an absolute path, and the walk follows its
 * parents as written, so the caller resolves symbolic links first if it wants the physical ones.
 * Only a regular file named `METHODS.toml` is a manifest.
 */
export function findManifestDirectory(startDirectory: string): string | null {
  let current = startDirectory;
  for (;;) {
    if (exactEntryKind(current, MANIFEST_NAME) === "file") return current;
    if (exactEntryKind(current, GIT_ENTRY_NAME) !== null) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
