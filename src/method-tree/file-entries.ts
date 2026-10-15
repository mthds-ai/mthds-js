/**
 * Reading a map of file entries as a receiver does (mthds/docs/spec/method-tree.md, "The File
 * Entry"), and writing one from a listed tree. A receiver detects a key given twice in the text it
 * parses rather than keep one of the values, so the map is read from its JSON text, or from a
 * value of `parseJsonDocument` when the map is a field of a larger request.
 */

import { compareUtf8, holdsLoneSurrogate, pathCollisions, treePathViolation } from "./tree-path.js";
import { sha256Hex, treeDigest } from "./digest.js";
import { MethodTreeError, type MapRefusalCode } from "./exceptions.js";
import { JsonDocumentError, parseJsonDocument, type JsonValue } from "./json-document.js";
import { MANIFEST_NAME, VENV_MARKER_NAME } from "./discovery.js";

/** A receiver's store of bytes it already holds, keyed by their SHA-256 in lowercase hexadecimal. */
export interface BlobStore {
  read(sha256: string): Promise<Uint8Array | null>;
}

/** A blob store holding nothing, as a receiver without one does. */
export const EMPTY_BLOB_STORE: BlobStore = {
  read: () => Promise.resolve(null),
};

/** A file of a tree read from a map, with its bytes. */
export interface ReadFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** A tree read from a map of file entries: its files in tree path order and its digest. */
export interface ReadTree {
  readonly files: readonly ReadFile[];
  readonly digest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INTEGER_LEXEME = /^-?(?:0|[1-9][0-9]*)$/;
const DEFAULT_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["__pycache__", "node_modules"]);

/**
 * Whether a key names a file the membership rule could never admit: one holding a segment that
 * starts with a dot, inside a `__pycache__` or `node_modules` directory, a file `pyvenv.cfg`, or
 * `METHODS.toml` below the root.
 */
export function isExcludedName(treePath: string): boolean {
  const segments = treePath.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return true;
  if (segments.slice(0, -1).some((segment) => DEFAULT_DIRECTORY_NAMES.has(segment))) return true;
  const last = segments[segments.length - 1];
  if (last === VENV_MARKER_NAME) return true;
  return last === MANIFEST_NAME && segments.length > 1;
}

/** Decode canonical padded standard Base64 with no line break, or `null` for anything else. */
export function decodeCanonicalBase64(encoded: string): Uint8Array | null {
  if (!BASE64.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  // Re-encoding gives the input back only when the pad bits are zero.
  return bytes.toString("base64") === encoded ? new Uint8Array(bytes) : null;
}

type EntryReading =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "blob"; readonly sha256: string; readonly size: bigint }
  | { readonly kind: "refused"; readonly code: MapRefusalCode };

/** An entry's bytes, the blob it names, or the code refusing it. */
function readEntry(entry: JsonValue): EntryReading {
  if (entry.kind === "string") {
    if (holdsLoneSurrogate(entry.value)) return { kind: "refused", code: "malformed_entry" };
    return { kind: "bytes", bytes: new Uint8Array(Buffer.from(entry.value, "utf8")) };
  }
  if (entry.kind !== "object") return { kind: "refused", code: "malformed_entry" };
  const keys = entry.pairs.map(([key]) => key);
  if (new Set(keys).size !== keys.length) return { kind: "refused", code: "duplicate_key" };
  const values = new Map(entry.pairs);
  if (keys.length === 1 && keys[0] === "base64") {
    const encoded = values.get("base64")!;
    if (encoded.kind !== "string") return { kind: "refused", code: "malformed_entry" };
    const bytes = decodeCanonicalBase64(encoded.value);
    return bytes === null ? { kind: "refused", code: "malformed_entry" } : { kind: "bytes", bytes };
  }
  if (keys.length === 2 && values.has("sha256") && values.has("size")) {
    const sha256 = values.get("sha256")!;
    const size = values.get("size")!;
    if (sha256.kind !== "string" || !SHA256_HEX.test(sha256.value)) {
      return { kind: "refused", code: "malformed_entry" };
    }
    if (size.kind !== "number" || !INTEGER_LEXEME.test(size.lexeme)) {
      return { kind: "refused", code: "malformed_entry" };
    }
    // A big integer keeps any size exact; one no store holds is a missing blob, not a malformation.
    const value = BigInt(size.lexeme);
    if (value < 0n) return { kind: "refused", code: "malformed_entry" };
    return { kind: "blob", sha256: sha256.value, size: value };
  }
  return { kind: "refused", code: "malformed_entry" };
}

/** The refusal codes of a map, the first one present deciding which is raised. */
const MAP_REFUSAL_PRIORITY: readonly MapRefusalCode[] = [
  "empty_tree",
  "duplicate_key",
  "invalid_tree_path",
  "excluded_name",
  "path_collision",
  "malformed_entry",
  "missing_blob",
];

/** The codes whose refusal names every offender, sorted; the others name the first one. */
const NAMES_ALL: ReadonlySet<MapRefusalCode> = new Set(["path_collision", "missing_blob"]);

function mapRefusalMessage(code: MapRefusalCode, names: readonly string[]): string {
  const first = names[0] ?? "";
  switch (code) {
    case "empty_tree":
      return "The map of file entries holds no file; a tree holds at least one.";
    case "duplicate_key":
      return `The map of file entries gives the key '${first}' twice, or its entry gives one of its own keys twice.`;
    case "invalid_tree_path":
      return `The map of file entries holds the key '${first}', which is not a tree path.`;
    case "excluded_name":
      return `The map of file entries holds the key '${first}', a name the membership rule never admits to a tree.`;
    case "path_collision":
      return `The map of file entries holds paths that collide once case-folded: ${names.join(", ")}.`;
    case "malformed_entry":
      return `The entry of '${first}' is none of a string, { "base64": … } and { "sha256": …, "size": … } as the standard writes them.`;
    case "missing_blob":
      return `The blob store does not hold, at the size stated, the blobs ${names.join(", ")}; upload them, then send the map again.`;
  }
}

/**
 * Read a map of file entries, given as a value of `parseJsonDocument`, into the tree it carries.
 * Refuses it with a `MethodTreeError` whose code the conformance corpus pins.
 */
export async function readFileEntryMapValue(
  document: JsonValue,
  blobStore: BlobStore = EMPTY_BLOB_STORE,
): Promise<ReadTree> {
  if (document.kind !== "object") {
    throw new MethodTreeError("malformed_document", "A map of file entries is a JSON object.");
  }
  const refusals = new Map<MapRefusalCode, string[]>();
  const refuse = (code: MapRefusalCode, name: string): void => {
    const names = refusals.get(code) ?? [];
    if (!names.includes(name)) names.push(name);
    refusals.set(code, names);
  };
  if (document.pairs.length === 0) refusals.set("empty_tree", []);
  // Every key is judged, a repeated one included; a key is a duplicate only when it is the same
  // string, so a key not in NFC is refused as no tree path, never beside the key it normalizes to.
  const seen = new Set<string>();
  const validKeys: string[] = [];
  const firstValues = new Map<string, JsonValue>();
  for (const [key, value] of document.pairs) {
    if (seen.has(key)) refuse("duplicate_key", key);
    seen.add(key);
    if (treePathViolation(key) !== null) {
      refuse("invalid_tree_path", key);
    } else if (isExcludedName(key)) {
      refuse("excluded_name", key);
    } else if (!firstValues.has(key)) {
      validKeys.push(key);
    }
    if (!firstValues.has(key)) firstValues.set(key, value);
  }
  for (const colliding of pathCollisions(validKeys)) refuse("path_collision", colliding);
  const blobs: { readonly path: string; readonly sha256: string; readonly size: bigint }[] = [];
  const contents = new Map<string, Uint8Array>();
  for (const key of validKeys) {
    const reading = readEntry(firstValues.get(key)!);
    if (reading.kind === "refused") refuse(reading.code, key);
    else if (reading.kind === "bytes") contents.set(key, reading.bytes);
    else blobs.push({ path: key, sha256: reading.sha256, size: reading.size });
  }
  // The blob store is read only for a map that is otherwise sound.
  if (refusals.size === 0) {
    for (const blob of blobs) {
      const held = await blobStore.read(blob.sha256);
      // A store is keyed by hash; bytes that do not hash to their key are not the blob named.
      if (held === null || BigInt(held.length) !== blob.size || sha256Hex(held) !== blob.sha256) {
        refuse("missing_blob", blob.sha256);
      } else {
        contents.set(blob.path, held);
      }
    }
  }
  for (const code of MAP_REFUSAL_PRIORITY) {
    const names = refusals.get(code);
    if (names === undefined) continue;
    const named = NAMES_ALL.has(code) ? [...names].sort(compareUtf8) : names.slice(0, 1);
    throw new MethodTreeError(code, mapRefusalMessage(code, named), { names: named });
  }
  const files = [...contents.entries()]
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256Hex(bytes), bytes }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  return { files, digest: treeDigest(files) };
}

/** Read a map of file entries from its JSON text into the tree it carries. */
export async function readFileEntryMap(
  text: string,
  blobStore: BlobStore = EMPTY_BLOB_STORE,
): Promise<ReadTree> {
  let document: JsonValue;
  try {
    document = parseJsonDocument(text);
  } catch (err) {
    if (err instanceof JsonDocumentError) {
      throw new MethodTreeError("malformed_document", err.message);
    }
    throw err;
  }
  return readFileEntryMapValue(document, blobStore);
}
