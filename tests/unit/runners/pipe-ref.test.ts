/**
 * `resolveQualifiedPipeRef` — the local runner's stand-in for the engine's pipe
 * lookup. The API resolves the selector against a loaded library; the local runner
 * never sees one, so it has to read the closure itself. That reading is the whole
 * risk surface, and these tests pin it.
 */

import { describe, it, expect } from "vitest";
import { resolveQualifiedPipeRef } from "../../../src/runners/pipe-ref.js";

const DOUBLE_QUOTED = 'domain = "smoke"\nmain_pipe = "echo"\n';
// TOML literal strings are ordinary, and pipelex parses them. A regex that only
// matched basic strings read this perfectly valid bundle as declaring no domain.
const SINGLE_QUOTED = "domain = 'smoke'\nmain_pipe = 'echo'\n";

function closure(...contents: string[]): { content: string }[] {
  return contents.map((content) => ({ content }));
}

describe("resolveQualifiedPipeRef — quote styles", () => {
  it.each([
    ["basic strings", DOUBLE_QUOTED],
    ["literal strings", SINGLE_QUOTED],
  ])("defaults to the declared main_pipe with TOML %s", (_label, content) => {
    expect(resolveQualifiedPipeRef(closure(content))).toBe("smoke.echo");
  });

  it.each([
    ["basic strings", DOUBLE_QUOTED],
    ["literal strings", SINGLE_QUOTED],
  ])("qualifies a bare ref against the domain declared with TOML %s", (_label, content) => {
    expect(resolveQualifiedPipeRef(closure(content), "echo")).toBe("smoke.echo");
  });
});

describe("resolveQualifiedPipeRef — the selector", () => {
  it("passes a qualified ref through untouched", () => {
    expect(resolveQualifiedPipeRef(closure(DOUBLE_QUOTED), "other.pipe")).toBe("other.pipe");
  });

  it("rejects an empty pipe_ref rather than silently defaulting", () => {
    // An empty string is a selector the caller SUPPLIED. Defaulting it would run a
    // different pipe than they asked for — and the API 422s on it (min_length=1),
    // so accepting it here would put the two runners on different contracts.
    expect(() => resolveQualifiedPipeRef(closure(DOUBLE_QUOTED), "")).toThrow(/empty string/);
    expect(() => resolveQualifiedPipeRef(closure(DOUBLE_QUOTED), "   ")).toThrow(/empty string/);
  });

  it("says the closure declares no domain, rather than printing an empty list", () => {
    expect(() => resolveQualifiedPipeRef(closure("main_pipe = 'echo'\n"), "echo")).toThrow(
      /no file in the closure declares a domain/,
    );
  });

  it("refuses to guess a bare ref across a multi-domain closure", () => {
    const files = closure(DOUBLE_QUOTED, "domain = 'other'\n");
    expect(() => resolveQualifiedPipeRef(files, "echo")).toThrow(/ambiguous/);
  });
});

describe("resolveQualifiedPipeRef — defaulting to main_pipe", () => {
  it("throws when the closure declares none", () => {
    expect(() => resolveQualifiedPipeRef(closure("domain = 'smoke'\n"))).toThrow(
      /declares no main_pipe/,
    );
  });

  it("throws when the closure declares several", () => {
    const files = closure(SINGLE_QUOTED, "domain = 'other'\nmain_pipe = 'run'\n");
    expect(() => resolveQualifiedPipeRef(files)).toThrow(/several main_pipe/);
  });
});
