import { describe, it, expect } from "vitest";
import { assertExclusiveRunSources, hasBundlePayload } from "../../../src/protocol/options.js";
import { PipelineRequestError } from "../../../src/protocol/exceptions.js";

describe("assertExclusiveRunSources", () => {
  it("accepts a single run source", () => {
    expect(() => assertExclusiveRunSources({ files: { "m.mthds": "x" } })).not.toThrow();
    expect(() => assertExclusiveRunSources({ bundle_b64: "UEs=" })).not.toThrow();
    expect(() => assertExclusiveRunSources({ mthds_contents: ["x"] })).not.toThrow();
    expect(() =>
      assertExclusiveRunSources({ pipe_code: "p", files: { "m.mthds": "x" } }),
    ).not.toThrow();
  });

  it("rejects both bundle encodings (presence, even if one is empty)", () => {
    expect(() =>
      assertExclusiveRunSources({ files: { "m.mthds": "x" }, bundle_b64: "UEs=" }),
    ).toThrow(PipelineRequestError);
    expect(() => assertExclusiveRunSources({ files: {}, bundle_b64: "UEs=" })).toThrow(
      PipelineRequestError,
    );
  });

  it("rejects a bundle combined with non-empty mthds_contents", () => {
    expect(() =>
      assertExclusiveRunSources({ files: { "m.mthds": "x" }, mthds_contents: ["y"] }),
    ).toThrow(PipelineRequestError);
    expect(() => assertExclusiveRunSources({ bundle_b64: "UEs=", mthds_contents: ["y"] })).toThrow(
      PipelineRequestError,
    );
  });

  it("ignores an empty mthds_contents array (no contents)", () => {
    expect(() =>
      assertExclusiveRunSources({ files: { "m.mthds": "x" }, mthds_contents: [] }),
    ).not.toThrow();
  });
});

describe("hasBundlePayload", () => {
  it("is true for a runnable bundle in either encoding", () => {
    expect(hasBundlePayload({ files: { "m.mthds": "x" } })).toBe(true);
    expect(hasBundlePayload({ bundle_b64: "UEs=" })).toBe(true);
  });

  it("is false for no bundle, or an empty encoding carrying no method", () => {
    expect(hasBundlePayload({})).toBe(false);
    expect(hasBundlePayload({ pipe_code: "p", mthds_contents: ["x"] })).toBe(false);
    // Empty encodings are present-but-not-runnable: exclusivity still counts
    // them (see assertExclusiveRunSources), the "something to run" test does not.
    expect(hasBundlePayload({ files: {} })).toBe(false);
    expect(hasBundlePayload({ bundle_b64: "" })).toBe(false);
  });
});
