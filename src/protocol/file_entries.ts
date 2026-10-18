/**
 * The file entry and the map of file entries (mthds/docs/spec/method-tree.md, "The File Entry";
 * the HTTP Runner Protocol's `FileEntry` and `MethodFiles` schemas): how a method tree travels
 * from one program to another, each file under its tree path, as its bytes or as their hash.
 *
 * Types only. Reading a map as a receiver does, with its duplicate keys, its collisions and its
 * blob store, is `readFileEntryMap` of the package's root entry, which needs Node.
 */

/** A file's text: its bytes are the UTF-8 encoding of the string, exactly. */
export type TextFileEntry = string;

/** Any bytes, in canonical padded standard Base64 (RFC 4648) with no line break. */
export interface Base64FileEntry {
  readonly base64: string;
}

/** Bytes the receiver already holds in its blob store, named by their SHA-256 and length. */
export interface HashFileEntry {
  /** The SHA-256 of the bytes, in lowercase hexadecimal. */
  readonly sha256: string;
  /** Their length in bytes, a JSON integer written without a fraction or an exponent. */
  readonly size: number;
}

export type FileEntry = TextFileEntry | Base64FileEntry | HashFileEntry;

/** A method tree as it travels: a map from tree path to file entry, holding at least one file. */
export type MethodFiles = Record<string, FileEntry>;

/**
 * A method tree a sender holds, before it travels: each file's tree path, size and SHA-256, the
 * tree digest, and a way to read a file's bytes. It is what a client hands to `execute`, `start`
 * and `validate` when it wants the client to choose how each file travels, inline or by hash
 * after `POST /blobs/missing` (the protocol's "Sending files by hash"). Never sent as such: the
 * client turns it into a `MethodFiles` map.
 *
 * `MethodTree`, which `listMethodTree` returns, is one; any other object of this shape is too,
 * such as a tree held in memory or read from an archive.
 */
export interface MethodTreeSource {
  /** Every file of the tree, each tree path once. */
  readonly files: readonly MethodTreeSourceFile[];
  /** The tree digest, `sha256:` and 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** The bytes of the file at `treePath`, which must hash to the SHA-256 the listing gives it. */
  readFile(treePath: string): Promise<Uint8Array>;
}

/** A file of a {@link MethodTreeSource}. */
export interface MethodTreeSourceFile {
  /** Its tree path. */
  readonly path: string;
  /** Its length in bytes. */
  readonly size: number;
  /** The SHA-256 of its bytes, in lowercase hexadecimal. */
  readonly sha256: string;
}
