/**
 * How a sender turns a method tree it holds into the `files` map a runner receives
 * (mthds/docs/spec/protocol.md, "Method files" and "Sending files by hash"), and what it learns
 * from a runner's handshake to choose. `MthdsApiClient` drives the requests; this module holds the
 * choices and the maps, with no network and no Node built-in.
 *
 * The rule: the whole tree travels inline when the runner keeps no blob store, or when its inline
 * map weighs `INLINE_TREE_MAX_BYTES` or less and no more than the runner's announced inline limit;
 * otherwise every file travels by hash, after `POST /blobs/missing` names the blobs to upload. The
 * weight is what the request spends: the map serialized as JSON with no whitespace, in UTF-8, so a
 * Base64 entry counts as its encoded text and a binary file weighs about a third more than its
 * bytes. A tree is never split between the two forms, so a run of an unchanged large method
 * uploads nothing and sends a map of hashes.
 */

import type {
  MethodFiles,
  MethodTreeSource,
  MethodTreeSourceFile,
} from "../../protocol/file_entries.js";
import type { BlobRef, VersionInfo } from "../../protocol/models.js";
import type { MethodTreeLimits } from "../../method-tree/lister.js";
import { defineFileEntry, inlineFileEntry } from "../../method-tree/file-entry-encoding.js";

/**
 * The heaviest inline map, in bytes of its JSON serialization, that travels inline when the runner
 * keeps a blob store. Below it a tree is cheaper to send whole than to check and upload; above it,
 * sending by hash spares the request body and lets an unchanged tree upload nothing.
 */
export const INLINE_TREE_MAX_BYTES = 256 * 1024;

/**
 * The limits a runner announces for a tree, in bytes for the sizes: the hosted platform's
 * `limits.method_tree` member of `GET /version`, an extension the protocol leaves open. A limit the
 * runner does not announce is absent.
 */
export interface AnnouncedTreeLimits {
  /** The files of one tree. */
  readonly maxFiles?: number;
  /** One file of it. */
  readonly maxFileBytes?: number;
  /** All its files together. */
  readonly maxTotalBytes?: number;
  /** The bytes a request carries inline for its tree: its text and Base64 entries. */
  readonly maxInlineBytes?: number;
}

/** Whether the runner's handshake declares a blob store. */
export function declaresBlobStore(version: VersionInfo): boolean {
  return version.blob_store === true;
}

/**
 * The tree limits a runner's handshake announces under `limits.method_tree`. A value that is not
 * a positive safe integer is left out rather than trusted, so a malformed handshake never makes a
 * lister refuse a sound tree.
 */
export function announcedTreeLimits(version: VersionInfo): AnnouncedTreeLimits {
  const limits = objectMember(version, "limits");
  const tree = limits === undefined ? undefined : objectMember(limits, "method_tree");
  if (tree === undefined) return {};
  const read = (name: string): number | undefined => {
    const value = tree[name];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : undefined;
  };
  return withoutUndefined({
    maxFiles: read("max_files"),
    maxFileBytes: read("max_file_bytes"),
    maxTotalBytes: read("max_total_bytes"),
    maxInlineBytes: read("max_inline_bytes"),
  });
}

/** The announced limits as the lister takes them, so it stops at the first breach before hashing. */
export function listerLimitsOf(announced: AnnouncedTreeLimits): MethodTreeLimits {
  return withoutUndefined({
    maxFileCount: announced.maxFiles,
    maxFileSize: announced.maxFileBytes,
    maxTotalSize: announced.maxTotalBytes,
  });
}

/** The total of a tree's file sizes, in bytes. */
export function treeTotalSize(tree: MethodTreeSource): number {
  return tree.files.reduce((total, file) => total + file.size, 0);
}

/**
 * Whether the tree might travel inline under `maxBytes`, judged from its file sizes alone, before
 * any file is read: its inline map weighs at least as much as its files, a text being its bytes
 * plus quotes and a Base64 entry more than its bytes, so a tree whose files pass the limit
 * cannot pass it inline.
 */
export function mightTravelInline(tree: MethodTreeSource, maxBytes: number): boolean {
  return treeTotalSize(tree) <= maxBytes;
}

/** What an inline map spends in a request: its JSON serialization with no whitespace, in UTF-8. */
export function inlineMapBytes(files: MethodFiles): number {
  return new TextEncoder().encode(JSON.stringify(files)).length;
}

/** Every file's bytes, by tree path, each read and checked by the tree, one file at a time. */
export async function readTreeBytes(tree: MethodTreeSource): Promise<Map<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  for (const file of tree.files) {
    bytes.set(file.path, await tree.readFile(file.path));
  }
  return bytes;
}

/** The whole tree as inline entries, from bytes already read by `readTreeBytes`. */
export function inlineFilesOf(
  tree: MethodTreeSource,
  bytesByPath: ReadonlyMap<string, Uint8Array>,
): MethodFiles {
  const files: MethodFiles = {};
  for (const file of tree.files) {
    const bytes = bytesByPath.get(file.path);
    if (bytes === undefined) throw new Error(`No bytes were read for '${file.path}'.`);
    defineFileEntry(files, file.path, inlineFileEntry(bytes));
  }
  return files;
}

/** The whole tree as inline entries, each file read and checked by the tree. */
export async function inlineMethodFiles(tree: MethodTreeSource): Promise<MethodFiles> {
  return inlineFilesOf(tree, await readTreeBytes(tree));
}

/** The whole tree as hash entries, which the runner resolves in its blob store. */
export function hashMethodFiles(tree: MethodTreeSource): MethodFiles {
  const files: MethodFiles = {};
  for (const file of tree.files) {
    defineFileEntry(files, file.path, { sha256: file.sha256, size: file.size });
  }
  return files;
}

/** Each blob of the tree once, in the tree's order: files with the same bytes share one blob. */
export function uniqueBlobs(tree: MethodTreeSource): BlobRef[] {
  const seen = new Set<string>();
  const blobs: BlobRef[] = [];
  for (const file of tree.files) {
    if (seen.has(file.sha256)) continue;
    seen.add(file.sha256);
    blobs.push({ sha256: file.sha256, size: file.size });
  }
  return blobs;
}

/** A file of the tree holding each blob, so a missing blob's bytes can be read and uploaded. */
export function fileByBlob(tree: MethodTreeSource): Map<string, MethodTreeSourceFile> {
  const files = new Map<string, MethodTreeSourceFile>();
  for (const file of tree.files) {
    if (!files.has(file.sha256)) files.set(file.sha256, file);
  }
  return files;
}

/**
 * Run `task` over `items`, at most `limit` at a time. The first task to fail stops the
 * run: no queued item is handed out after it, `signal` is aborted so the tasks still in
 * flight can stop early, and once they have settled the first failure is thrown.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await task(item, controller.signal);
      } catch (error) {
        if (failure === undefined) {
          failure = { error };
          controller.abort(error);
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

function objectMember(holder: object, name: string): Record<string, unknown> | undefined {
  const value = (holder as Record<string, unknown>)[name];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, member]) => member !== undefined),
  ) as T;
}
