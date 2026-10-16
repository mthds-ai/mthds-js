import { describe, it, expect } from "vitest";
import { assertOneMethodSource, hasMethodSource } from "../../../src/protocol/options.js";
import { PipelineRequestError } from "../../../src/protocol/exceptions.js";
import type { MethodTreeSource } from "../../../src/protocol/file_entries.js";

function tree(paths: string[]): MethodTreeSource {
  return {
    files: paths.map((path) => ({ path, size: 1, sha256: "0".repeat(64) })),
    digest: `sha256:${"0".repeat(64)}`,
    readFile: () => Promise.resolve(new Uint8Array([0x78])),
  };
}

describe("assertOneMethodSource", () => {
  it("accepts a method named once, as files or as a tree, with or without a pipe code", () => {
    expect(() => assertOneMethodSource({ files: { "m.mthds": "x" } })).not.toThrow();
    expect(() => assertOneMethodSource({ tree: tree(["m.mthds"]) })).not.toThrow();
    expect(() =>
      assertOneMethodSource({ pipe_code: "p", files: { "m.mthds": "x" } }),
    ).not.toThrow();
    expect(() => assertOneMethodSource({ pipe_code: "p" })).not.toThrow();
  });

  it("refuses files beside a tree, on presence even when one is empty", () => {
    expect(() =>
      assertOneMethodSource({ files: { "m.mthds": "x" }, tree: tree(["m.mthds"]) }),
    ).toThrow(PipelineRequestError);
    expect(() => assertOneMethodSource({ files: {}, tree: tree(["m.mthds"]) })).toThrow(
      PipelineRequestError,
    );
  });
});

describe("hasMethodSource", () => {
  it("is true for a map or a tree holding a file", () => {
    expect(hasMethodSource({ files: { "m.mthds": "x" } })).toBe(true);
    expect(hasMethodSource({ files: { "m.mthds": { sha256: "0".repeat(64), size: 1 } } })).toBe(
      true,
    );
    expect(hasMethodSource({ tree: tree(["m.mthds"]) })).toBe(true);
  });

  it("is false for no method, or an empty map or tree carrying none", () => {
    expect(hasMethodSource({})).toBe(false);
    expect(hasMethodSource({ pipe_code: "p" })).toBe(false);
    expect(hasMethodSource({ files: {} })).toBe(false);
    expect(hasMethodSource({ files: null })).toBe(false);
    expect(hasMethodSource({ tree: tree([]) })).toBe(false);
  });
});
