/**
 * `readBundleMeta` — the bundle-level `domain` and `main_pipe` a pipe selection
 * reads, for a run's bare `pipe_code` and for the entry pipe an inputs command asks
 * for. Reading them is the whole risk surface, and these tests pin it.
 */

import { describe, it, expect } from "vitest";
import { readBundleMeta } from "../../../src/runners/pipe-ref.js";

const DOUBLE_QUOTED = 'domain = "smoke"\nmain_pipe = "echo"\n';
// TOML literal strings are ordinary, and pipelex parses them. A regex that only
// matched basic strings read this perfectly valid bundle as declaring no domain.
const SINGLE_QUOTED = "domain = 'smoke'\nmain_pipe = 'echo'\n";
// TOML also permits QUOTED KEYS, and comments anywhere. This is why the metadata is
// read with the real TOML parser instead of pattern-matching the source.
const QUOTED_KEYS = "# a comment\n\"domain\" = \"smoke\"\n\n'main_pipe' = 'echo'  # trailing\n";

describe("readBundleMeta — TOML spellings", () => {
  it.each([
    ["basic strings", DOUBLE_QUOTED],
    ["literal strings", SINGLE_QUOTED],
    ["quoted keys + comments", QUOTED_KEYS],
  ])("reads the domain and main_pipe written with TOML %s", (_label, content) => {
    expect(readBundleMeta(content)).toEqual({ domain: "smoke", mainPipe: "echo" });
  });
});

describe("readBundleMeta — what it leaves absent", () => {
  it("leaves a key the bundle does not declare undefined", () => {
    expect(readBundleMeta("domain = 'smoke'\n")).toEqual({ domain: "smoke", mainPipe: undefined });
    expect(readBundleMeta("main_pipe = 'echo'\n")).toEqual({
      domain: undefined,
      mainPipe: "echo",
    });
  });

  it("ignores a key whose value is not a string", () => {
    expect(readBundleMeta("domain = 3\nmain_pipe = ['echo']\n")).toEqual({
      domain: undefined,
      mainPipe: undefined,
    });
  });

  it("ignores a key declared inside a table rather than at the top level", () => {
    expect(readBundleMeta("[pipe.echo]\nmain_pipe = 'echo'\n")).toEqual({
      domain: undefined,
      mainPipe: undefined,
    });
  });

  it("treats a bundle it cannot parse as declaring nothing rather than throwing", () => {
    // The CLI and the engine own that diagnostic, and they say it far better.
    expect(readBundleMeta("domain = \nthis is not toml [[[\n")).toEqual({});
  });
});
