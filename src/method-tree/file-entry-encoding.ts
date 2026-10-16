/**
 * Turning a file's bytes into the file entry it travels as (mthds/docs/spec/method-tree.md, "The
 * File Entry"): its text when the bytes are UTF-8, so the string's UTF-8 encoding gives back the
 * same bytes, and canonical padded standard Base64 otherwise.
 *
 * Pure: no Node built-in, no `Buffer`, so a sender in any JavaScript runtime encodes a file the
 * way `MethodTree.toMethodFiles()` does.
 */

import type { FileEntry, MethodFiles } from "../protocol/file_entries.js";

// `ignoreBOM` keeps a leading byte order mark in the text, so the entry gives back every byte.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** The bytes as text when they are UTF-8, or `null` when they are not. */
export function utf8TextOf(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** Canonical padded standard Base64 (RFC 4648), with no line break and its pad bits zero. */
export function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let line = "";
  const full = bytes.length - (bytes.length % 3);
  for (let index = 0; index < full; index += 3) {
    const triple = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    line +=
      BASE64_ALPHABET[(triple >> 18) & 63]! +
      BASE64_ALPHABET[(triple >> 12) & 63]! +
      BASE64_ALPHABET[(triple >> 6) & 63]! +
      BASE64_ALPHABET[triple & 63]!;
    // Flush now and then, so a file of many megabytes is not one string grown a character at a time.
    if (line.length >= 8192) {
      chunks.push(line);
      line = "";
    }
  }
  const rest = bytes.length - full;
  if (rest === 1) {
    const value = bytes[full]! << 16;
    line += BASE64_ALPHABET[(value >> 18) & 63]! + BASE64_ALPHABET[(value >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const value = (bytes[full]! << 16) | (bytes[full + 1]! << 8);
    line +=
      BASE64_ALPHABET[(value >> 18) & 63]! +
      BASE64_ALPHABET[(value >> 12) & 63]! +
      BASE64_ALPHABET[(value >> 6) & 63]! +
      "=";
  }
  chunks.push(line);
  return chunks.join("");
}

/** The entry a file travels as inline: its text when its bytes are UTF-8, its Base64 otherwise. */
export function inlineFileEntry(bytes: Uint8Array): FileEntry {
  const text = utf8TextOf(bytes);
  return text ?? { base64: encodeBase64(bytes) };
}

/**
 * Add a file to a map of file entries as an own property, since assigning to a key such as
 * `__proto__`, a tree path like any other, would set the object's prototype instead of adding the
 * file.
 */
export function defineFileEntry(files: MethodFiles, treePath: string, entry: FileEntry): void {
  Object.defineProperty(files, treePath, {
    value: entry,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
