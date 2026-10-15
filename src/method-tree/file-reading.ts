/**
 * Reading a file of a listed tree: the one way the lister hashes a member and a listed tree reads
 * one back. The walk judged each member from `lstat`, so the file is opened without following a
 * link and without blocking on a named pipe, confirmed a regular file on its own descriptor, and
 * streamed into SHA-256 rather than read whole first. A file swapped for a link, a special file or a
 * directory since the walk is refused under its own code, and any other failure as `not_listable`
 * naming the file, never as a raw Node error.
 */

import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MethodTreeError } from "./exceptions.js";

// Neither flag exists on Windows, where the walk's own `lstat` is the only guard.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CHUNK_SIZE = 64 * 1024;

/** A member as read: its length, the SHA-256 of its bytes and, when asked for, the bytes. */
export interface ReadMember {
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Buffer | null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function linkRefusal(path: string, where: string): MethodTreeError {
  return new MethodTreeError(
    "symbolic_link",
    `'${path}' under ${where} is now a symbolic link, which a method tree never follows; replace it with the file itself and list the tree again.`,
    { names: [path] },
  );
}

function specialRefusal(path: string, where: string): MethodTreeError {
  return new MethodTreeError(
    "special_file",
    `'${path}' under ${where} is now neither a file nor a directory, such as a named pipe or a device; remove it and list the tree again.`,
    { names: [path] },
  );
}

function unreadable(path: string, where: string, err: unknown): MethodTreeError {
  return new MethodTreeError(
    "not_listable",
    `Cannot read '${path}' under ${where}: ${describe(err)}`,
    {
      names: [path],
    },
  );
}

function refusalOfOpenError(err: unknown, path: string, where: string): MethodTreeError {
  switch (errorCode(err)) {
    // `O_NOFOLLOW` on a link fails with ELOOP, or EMLINK on the BSDs.
    case "ELOOP":
    case "EMLINK":
      return linkRefusal(path, where);
    // A socket cannot be opened as a file.
    case "ENXIO":
    case "EOPNOTSUPP":
      return specialRefusal(path, where);
    default:
      return unreadable(path, where, err);
  }
}

function refusalOfStats(stats: Stats, path: string, where: string): MethodTreeError {
  if (stats.isDirectory()) {
    return new MethodTreeError(
      "not_listable",
      `'${path}' under ${where} is now a directory, not the file the method tree listed; list the tree again.`,
      { names: [path] },
    );
  }
  return specialRefusal(path, where);
}

/**
 * Read the member at `absolute`, whose tree path is `path`, hashing it as it streams. `where` names
 * the tree in a refusal: its root, or the file itself for a one-file tree.
 */
export async function readMember(
  absolute: Buffer | string,
  path: string,
  where: string,
  keepBytes: boolean,
): Promise<ReadMember> {
  let handle: FileHandle;
  try {
    handle = await open(absolute, OPEN_FLAGS);
  } catch (err) {
    throw refusalOfOpenError(err, path, where);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw refusalOfStats(stats, path, where);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    let buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      size += bytesRead;
      if (keepBytes) {
        chunks.push(chunk);
        buffer = Buffer.allocUnsafe(CHUNK_SIZE);
      }
    }
    return {
      size,
      sha256: hash.digest("hex"),
      bytes: keepBytes ? Buffer.concat(chunks, size) : null,
    };
  } catch (err) {
    if (err instanceof MethodTreeError) throw err;
    throw unreadable(path, where, err);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
