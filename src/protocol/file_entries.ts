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
