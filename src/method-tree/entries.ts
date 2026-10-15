/** The kind of a directory entry as a listing reads it, without following a symbolic link. */

import type { Dirent } from "node:fs";
import type { EntryKind } from "./discovery.js";

/** What a `readdir` entry is; Node reads it with `lstat` when the file system does not say. */
export function entryKindOfDirent(dirent: Dirent<Buffer>): EntryKind {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "directory";
  return "other";
}
