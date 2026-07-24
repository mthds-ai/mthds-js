import { describe, it, expect } from "vitest";
import {
  serializeMethodFiles,
  parseMethodFiles,
  type MethodFile,
} from "../../../src/protocol/method_files.js";
import { PipelineRequestError } from "../../../src/protocol/exceptions.js";

const FILES: MethodFile[] = [
  { name: "bundle.mthds", content: "domain = 'x'" },
  { name: "funcs/price.py", content: "def price(): ..." },
];

describe("serializeMethodFiles", () => {
  it("serializes files to a JSON [{ name, content }] array", () => {
    expect(JSON.parse(serializeMethodFiles(FILES))).toEqual(FILES);
  });

  it("serializes an empty list to '' (the platform's no-source sentinel), not '[]'", () => {
    expect(serializeMethodFiles([])).toBe("");
  });

  it("drops blank-content entries, so an all-blank list serializes to ''", () => {
    expect(serializeMethodFiles([{ name: "empty.py", content: "   " }])).toBe("");
    const kept = JSON.parse(
      serializeMethodFiles([
        { name: "a.py", content: "x" },
        { name: "b.py", content: "" },
      ]),
    );
    expect(kept).toEqual([{ name: "a.py", content: "x" }]);
  });

  it("normalizes entries to exactly { name, content } (strips extra keys)", () => {
    const serialized = serializeMethodFiles([
      { name: "a.py", content: "x", extra: "drop me" } as unknown as MethodFile,
    ]);
    expect(JSON.parse(serialized)).toEqual([{ name: "a.py", content: "x" }]);
  });
});

describe("parseMethodFiles", () => {
  it("parses a JSON [{ name, content }] array back into files", () => {
    expect(parseMethodFiles(JSON.stringify(FILES))).toEqual(FILES);
  });

  it("treats blank / null / undefined / '[]' as no files", () => {
    expect(parseMethodFiles("")).toEqual([]);
    expect(parseMethodFiles("   ")).toEqual([]);
    expect(parseMethodFiles(null)).toEqual([]);
    expect(parseMethodFiles(undefined)).toEqual([]);
    expect(parseMethodFiles("[]")).toEqual([]);
  });

  it("drops blank-content entries (round-trip-stable with serialize)", () => {
    expect(
      parseMethodFiles(
        JSON.stringify([
          { name: "a.py", content: "x" },
          { name: "b.py", content: " " },
        ]),
      ),
    ).toEqual([{ name: "a.py", content: "x" }]);
  });

  it("round-trips serialize → parse", () => {
    expect(parseMethodFiles(serializeMethodFiles(FILES))).toEqual(FILES);
    expect(parseMethodFiles(serializeMethodFiles([]))).toEqual([]);
  });

  it("throws on non-JSON text (raw source is not the catalog array form)", () => {
    expect(() => parseMethodFiles("domain = 'x'")).toThrow(PipelineRequestError);
  });

  it("throws on a non-array JSON value", () => {
    expect(() => parseMethodFiles('{"name":"a.py","content":"x"}')).toThrow(PipelineRequestError);
  });

  it("throws on an array entry that is not { name, content }", () => {
    expect(() => parseMethodFiles('[{"name":"a.py"}]')).toThrow(PipelineRequestError);
    expect(() => parseMethodFiles('["a.py"]')).toThrow(PipelineRequestError);
  });
});
