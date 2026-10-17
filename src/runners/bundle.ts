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
import { decodeCanonicalBase64, readFileEntryObject } from "../method-tree/file-entries.js";
import { MethodTreeError } from "../method-tree/exceptions.js";

/**
 * Read the map as a runner receives it (`file-entries.ts`), refusing what a receiver refuses
 * before anything is written: a key that is not a tree path, such as one holding `..` or an
 * absolute path, a name the membership rule never admits, such as a dot segment or a run's
 * `inputs.json`, which pipelex would otherwise find beside the bundles and read as the run's
 * inputs, colliding keys and a malformed entry. This runner keeps no blob store, so a hash entry
 * in a map otherwise sound is refused, naming its tree path.
 */
async function checkMethodFiles(files: MethodFiles): Promise<void> {
  try {
    await readFileEntryObject(files);
  } catch (err) {
    if (!(err instanceof MethodTreeError)) throw err;
    if (err.code === "missing_blob") {
      const hashed = Object.keys(files).find((treePath) => isHashEntry(files[treePath]));
      throw new PipelineRequestError(
        `The local pipelex runner keeps no blob store, so it cannot resolve the hash entry of '${hashed ?? err.names[0] ?? ""}'. Send the file inline, or pass the method as a tree.`,
        { cause: err },
      );
    }
    throw new PipelineRequestError(
      `The local pipelex runner refuses the method's files: ${err.message}`,
      { cause: err },
    );
  }
}

function isHashEntry(entry: unknown): boolean {
  return entry !== null && typeof entry === "object" && "sha256" in entry;
}

/**
 * Resolve a tree path to an absolute path GUARANTEED to stay under `root`, or throw. The map
 * check has already refused every key that is not a tree path; this guard stays so that no key
 * ever lets `writeFileSync` clobber a file elsewhere with the process's permissions.
 */
function resolveSafeBundlePath(root: string, rel: string): string {
  const abs = resolve(root, ...rel.split("/"));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new PipelineRequestError(
      `Unsafe file path ${JSON.stringify(rel)}: it escapes the method's directory.`,
    );
  }
  return abs;
}

/** The bytes of an inline entry the map check accepted: its text, or its Base64 decoded. */
function entryBytes(entry: FileEntry): string | Uint8Array {
  if (typeof entry === "string") return entry;
  return decodeCanonicalBase64((entry as { base64: string }).base64)!;
}

/**
 * Write a method's `files` map into `targetDir`, recreating its directories (so
 * `funcs/*.py` land under `funcs/`) and writing each file's exact bytes: a text
 * entry as UTF-8, a Base64 entry decoded. `targetDir` is the tree's root and holds
 * nothing else, so no file a run writes can land on a file of the method. The whole
 * map is checked as a receiver checks it before any write, so a key or an entry a
 * receiver refuses is refused instead of written, and so is a hash entry, which
 * needs a blob store.
 */
export async function materializeMethodFiles(targetDir: string, files: MethodFiles): Promise<void> {
  await checkMethodFiles(files);
  const root = resolve(targetDir);
  const writes = Object.entries(files).map(
    ([rel, entry]) => [resolveSafeBundlePath(root, rel), entryBytes(entry)] as const,
  );
  mkdirSync(root, { recursive: true });
  for (const [abs, bytes] of writes) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}
