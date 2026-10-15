/** What the corpus does not exercise of reading a map of file entries and of its JSON parser. */

import { describe, expect, it } from "vitest";
import {
  decodeCanonicalBase64,
  JsonDocumentError,
  MethodTreeError,
  parseJsonDocument,
  readFileEntryMap,
} from "../../../src/method-tree/index.js";

describe("parseJsonDocument", () => {
  it("keeps every pair of an object, a key given twice included", () => {
    expect(parseJsonDocument('{"a": 1, "a": 2}')).toEqual({
      kind: "object",
      pairs: [
        ["a", { kind: "number", lexeme: "1" }],
        ["a", { kind: "number", lexeme: "2" }],
      ],
    });
  });

  it("keeps a number's lexeme", () => {
    expect(parseJsonDocument("[13.0, 1.3e1, -0]")).toEqual({
      kind: "array",
      items: [
        { kind: "number", lexeme: "13.0" },
        { kind: "number", lexeme: "1.3e1" },
        { kind: "number", lexeme: "-0" },
      ],
    });
  });

  it("decodes escapes, a lone surrogate included", () => {
    const parsed = parseJsonDocument(String.raw`"a\u0062\n\ud800"`);
    expect(parsed).toEqual({ kind: "string", value: `ab\n${String.fromCharCode(0xd800)}` });
  });

  it("refuses what is not strict JSON", () => {
    for (const text of [
      "",
      "{",
      "[1,]",
      "NaN",
      "01",
      '{"a" 1}',
      '"tab\there"',
      String.fromCharCode(0xfeff) + "{}",
      "{} x",
      "'a'",
    ]) {
      expect(() => parseJsonDocument(text), text).toThrow(JsonDocumentError);
    }
  });
});

describe("decodeCanonicalBase64", () => {
  it("decodes canonical padded Base64 and refuses anything else", () => {
    expect(Buffer.from(decodeCanonicalBase64("aGk=")!).toString()).toBe("hi");
    expect(decodeCanonicalBase64("")).toEqual(new Uint8Array());
    for (const encoded of [
      "aGl=",
      "aGk",
      "aG k=",
      "-_8=",
      "YR==",
      "a===",
      "====",
      "aG=k",
      "aGk\n",
    ]) {
      expect(decodeCanonicalBase64(encoded), encoded).toBeNull();
    }
  });

  it("decodes a payload of several megabytes without exhausting the stack", () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024 + 1, 0xa7);
    const decoded = decodeCanonicalBase64(bytes.toString("base64"));
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded!).equals(bytes)).toBe(true);
    expect(decodeCanonicalBase64(`${bytes.toString("base64").slice(0, -4)}!AAA`)).toBeNull();
  });
});

describe("readFileEntryMap", () => {
  it("refuses a document that is not a JSON object", async () => {
    for (const text of ["[]", "not json"]) {
      await expect(readFileEntryMap(text)).rejects.toMatchObject({ code: "malformed_document" });
    }
  });

  it("reads a size too large for a number exactly, as a blob no store holds", async () => {
    const hash = "a".repeat(64);
    const err = await readFileEntryMap(
      `{"a.txt": {"sha256": "${hash}", "size": 123456789012345678901234567890}}`,
    ).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(MethodTreeError);
    expect(err).toMatchObject({ code: "missing_blob", names: [hash] });
  });

  it("refuses a blob whose bytes do not hash to the name it is held under", async () => {
    const hash = "b".repeat(64);
    const store = { read: () => Promise.resolve(new Uint8Array([1, 2, 3])) };
    await expect(
      readFileEntryMap(`{"a.txt": {"sha256": "${hash}", "size": 3}}`, store),
    ).rejects.toMatchObject({ code: "missing_blob" });
  });
});
