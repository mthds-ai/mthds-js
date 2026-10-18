/**
 * Reading a method's tree for `mthds install`, `publish` and `share`: every file the standard's
 * lister admits from the method's directory, with its exact bytes, so a method's Python, templates,
 * images and other files travel with its manifest and bundles. The directory is the tree's root
 * whatever lies above it, as a package directory is.
 */

import { listMethodTree } from "../../method-tree/lister.js";
import { MethodTreeError } from "../../method-tree/exceptions.js";
import type { MethodsFile } from "../../package/manifest/types.js";

/** The files of the method's tree rooted at `directory`, with their bytes. */
export async function readMethodTreeFiles(directory: string): Promise<MethodsFile[]> {
  const tree = await listMethodTree(directory, { discover: false });
  const files: MethodsFile[] = [];
  for (const file of tree.files) {
    files.push({ path: file.path, bytes: new Uint8Array(await tree.readFile(file.path)) });
  }
  return files;
}

/**
 * The files of a method's tree, or the reason the method is skipped when its tree is refused,
 * such as a tree holding a symbolic link. Any other failure reaches the caller.
 */
export async function readMethodTreeOrSkip(
  directory: string,
): Promise<{ files: MethodsFile[] } | { error: string }> {
  try {
    return { files: await readMethodTreeFiles(directory) };
  } catch (err) {
    if (err instanceof MethodTreeError) {
      return { error: `The method's tree is refused: ${err.message}` };
    }
    throw err;
  }
}
