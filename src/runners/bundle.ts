/**
 * Writing a method tree to disk for the local pipelex runner.
 *
 * A method travels as its tree, the protocol's `files` map (`method-target.ts`
 * resolves what a command line names into one). The local pipelex runner reads
 * files from disk, so `materializeMethodFiles` writes such a map back into a
 * directory of its own, its Python, templates and other files beside its
 * bundles; pipelex then lists that directory and chooses the bundle to start at.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { FileEntry, MethodFiles } from "../protocol/file_entries.js";
import { PipelineRequestError } from "../protocol/exceptions.js";
import { decodeCanonicalBase64 } from "../method-tree/file-entries.js";
import { treePathViolation } from "../method-tree/tree-path.js";

/**
 * Resolve a tree path to an absolute path GUARANTEED to stay under `root`, or
 * throw. A `files` map reaches this from the public `RunOptions.files` (a
 * programmatic caller can put anything there), so a key like `../../outside` or
 * an absolute path must never let `writeFileSync` clobber a file elsewhere with
 * the process's permissions. A key that is not a tree path is refused first, as a
 * runner refuses it.
 */
function resolveSafeBundlePath(root: string, rel: string): string {
  const violation = treePathViolation(rel);
  if (violation !== null) {
    throw new PipelineRequestError(
      `The key ${JSON.stringify(rel)} of the method's files is not a tree path: ${violation}.`,
    );
  }
  const abs = resolve(root, ...rel.split("/"));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new PipelineRequestError(
      `Unsafe file path ${JSON.stringify(rel)}: it escapes the method's directory.`,
    );
  }
  return abs;
}

/** The bytes of an inline entry, refusing a hash entry, which only a blob store resolves. */
function entryBytes(treePath: string, entry: FileEntry): string | Uint8Array {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object" && "base64" in entry) {
    const bytes = decodeCanonicalBase64(entry.base64);
    if (bytes === null) {
      throw new PipelineRequestError(
        `The entry of '${treePath}' is not canonical padded standard Base64.`,
      );
    }
    return bytes;
  }
  throw new PipelineRequestError(
    `The local pipelex runner keeps no blob store, so it cannot resolve the hash entry of '${treePath}'. Send the file inline, or pass the method as a tree.`,
  );
}

/**
 * Write a method's `files` map into `targetDir`, recreating its directories (so
 * `funcs/*.py` land under `funcs/`) and writing each file's exact bytes: a text
 * entry as UTF-8, a Base64 entry decoded. `targetDir` is the tree's root and holds
 * nothing else, so no file a run writes can land on a file of the method. Every key
 * is checked before any write, so a key that is not a tree path, or that would
 * escape `targetDir`, is refused instead of written, and so is a hash entry, which
 * needs a blob store.
 */
export function materializeMethodFiles(targetDir: string, files: MethodFiles): void {
  const root = resolve(targetDir);
  const writes = Object.entries(files).map(
    ([rel, entry]) => [resolveSafeBundlePath(root, rel), entryBytes(rel, entry)] as const,
  );
  mkdirSync(root, { recursive: true });
  for (const [abs, bytes] of writes) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}
