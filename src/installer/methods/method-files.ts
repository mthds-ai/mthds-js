/**
 * The method tree `mthds install` validates a resolved method as: its `METHODS.toml` at the root
 * and its `.mthds` files, the files the resolvers read, under their paths from the method's
 * directory. A path that is not a tree path, or that names a file the membership rule could never
 * admit, such as one inside a `.venv` or a `node_modules` directory, is left out, as a lister
 * leaves it out.
 */

import { sep } from "node:path";
import type { MethodFiles } from "../../protocol/file_entries.js";
import type { ResolvedMethod } from "../../package/manifest/types.js";
import { defineFileEntry } from "../../method-tree/file-entry-encoding.js";
import { MANIFEST_NAME, isExcludedName } from "../../method-tree/membership.js";
import { treePathViolation } from "../../method-tree/tree-path.js";

/** The resolved method as the `files` map its validation sends. */
export function resolvedMethodFiles(method: ResolvedMethod): MethodFiles {
  const files: MethodFiles = {};
  defineFileEntry(files, MANIFEST_NAME, method.rawManifest);
  for (const file of method.files) {
    // The local resolver gives paths with this system's separator, the GitHub one with `/`.
    const treePath = file.relativePath.split(sep).join("/").normalize("NFC");
    if (treePath === MANIFEST_NAME) continue;
    if (treePathViolation(treePath) !== null || isExcludedName(treePath)) continue;
    defineFileEntry(files, treePath, file.content);
  }
  return files;
}
