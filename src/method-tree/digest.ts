/**
 * The tree digest (mthds/docs/spec/method-tree.md, "The Tree Digest"): `sha256:` and the SHA-256 of
 * the tree's listing, one `sha256sum` line per file sorted by tree path byte for byte.
 */

import { createHash } from "node:crypto";
import { compareUtf8 } from "./tree-path.js";

/** The prefix of a tree digest. */
export const TREE_DIGEST_PREFIX = "sha256:";

/** What a tree digest looks like, as the lock file and the protocol write it. */
export const TREE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A file of a tree as its digest sees it: its tree path and the SHA-256 of its bytes. */
export interface DigestedFile {
  readonly path: string;
  readonly sha256: string;
}

/** The lowercase hexadecimal SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The tree's listing: what `sha256sum` prints for each file, in tree path order, byte for byte. */
export function treeListing(files: readonly DigestedFile[]): string {
  return [...files]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((file) => `${file.sha256}  ${file.path}\n`)
    .join("");
}

/** The tree digest of a tree holding `files`. */
export function treeDigest(files: readonly DigestedFile[]): string {
  return `${TREE_DIGEST_PREFIX}${sha256Hex(Buffer.from(treeListing(files), "utf8"))}`;
}
