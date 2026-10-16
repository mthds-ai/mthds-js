import { describe, expect, it } from "vitest";
import {
  defineFileEntry,
  encodeBase64,
  inlineFileEntry,
} from "../../../src/method-tree/file-entry-encoding.js";
import { decodeCanonicalBase64 } from "../../../src/method-tree/file-entries.js";
import type { MethodFiles } from "../../../src/protocol/file_entries.js";

describe("encodeBase64", () => {
  it("matches Node's canonical padded Base64 for every remainder and a long input", () => {
    const samples = [0, 1, 2, 3, 4, 5, 100, 20_000].map((length) =>
      Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256),
    );
    for (const bytes of samples) {
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(decodeCanonicalBase64(encoded)).toEqual(bytes);
    }
  });
});

describe("inlineFileEntry", () => {
  it("gives UTF-8 bytes as their text, a byte order mark kept", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9]);
    const entry = inlineFileEntry(bytes);
    expect(entry).toBe("﻿hé");
    expect(new TextEncoder().encode(entry as string)).toEqual(bytes);
  });

  it("gives any other bytes in Base64", () => {
    expect(inlineFileEntry(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ base64: "//4A" });
  });
});

describe("defineFileEntry", () => {
  it("adds a file named __proto__ as an own key, which JSON carries", () => {
    const files: MethodFiles = {};
    defineFileEntry(files, "__proto__", "data");
    expect(Object.keys(files)).toEqual(["__proto__"]);
    expect(JSON.stringify(files)).toBe('{"__proto__":"data"}');
  });
});
