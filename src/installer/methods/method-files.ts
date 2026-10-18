/**
 * The tree `mthds install` validates and installs a resolved method as: every file of its tree,
 * as the resolvers read it with the standard's lister, with the `METHODS.toml` the resolver
 * validated at the root when the tree leaves it out (a `.gitignore` or the manifest's own
 * `exclude` can). What is validated is what is installed.
 */

import type { MethodTreeSource } from "../../protocol/file_entries.js";
import type { MethodsFile, ResolvedMethod } from "../../package/manifest/types.js";
import { sha256Hex, treeDigest } from "../../method-tree/digest.js";
import { MANIFEST_NAME } from "../../method-tree/membership.js";
import { compareUtf8 } from "../../method-tree/tree-path.js";

/** The files a resolved method installs, its manifest at the root, sorted by tree path byte for byte. */
export function installedMethodFiles(method: ResolvedMethod): MethodsFile[] {
  const files = [...method.files];
  if (!files.some((file) => file.path === MANIFEST_NAME)) {
    files.push({ path: MANIFEST_NAME, bytes: new TextEncoder().encode(method.rawManifest) });
  }
  return files.sort((left, right) => compareUtf8(left.path, right.path));
}

/** The resolved method as the tree its validation sends, held in memory. */
export function resolvedMethodTree(method: ResolvedMethod): MethodTreeSource {
  const installed = installedMethodFiles(method);
  const bytesByPath = new Map(installed.map((file) => [file.path, file.bytes]));
  const files = installed.map((file) => ({
    path: file.path,
    size: file.bytes.length,
    sha256: sha256Hex(file.bytes),
  }));
  return {
    files,
    digest: treeDigest(files),
    readFile: (treePath) => {
      const bytes = bytesByPath.get(treePath);
      if (bytes === undefined) {
        return Promise.reject(new Error(`'${treePath}' is not a file of the method's tree.`));
      }
      return Promise.resolve(bytes);
    },
  };
}

/** A resolved method's tree in words, for a summary line: its files, and how many are bundles. */
export function describeTreeFiles(method: ResolvedMethod): string {
  const files = installedMethodFiles(method).length;
  const bundles = method.files.filter((file) => file.path.endsWith(".mthds")).length;
  return `${files} file${files === 1 ? "" : "s"}, ${bundles} .mthds bundle${bundles === 1 ? "" : "s"}`;
}
