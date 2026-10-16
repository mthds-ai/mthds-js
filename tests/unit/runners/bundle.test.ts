import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickMainBundleFile, materializeBundleFiles } from "../../../src/runners/bundle.js";

const MTHDS = [
  'domain      = "pf_hostname_probe"',
  'main_pipe   = "probe_host"',
  "[pipe.probe_host]",
  'type          = "PipeFunc"',
  'function_name = "probe_host"',
].join("\n");

const FUNC = "@pipe_func(name='probe_host')\nasync def probe_host(): ...\n";

describe("pickMainBundleFile", () => {
  it("prefers a root-level .mthds declaring main_pipe", () => {
    const files = {
      "sub/other.mthds": 'domain = "x"',
      "root.mthds": MTHDS,
      "funcs/x.py": FUNC,
    };
    expect(pickMainBundleFile(files)).toBe("root.mthds");
  });
  it("falls back to the first .mthds when none declares main_pipe", () => {
    expect(pickMainBundleFile({ "a.mthds": 'domain = "x"' })).toBe("a.mthds");
  });
  it("throws when there is no .mthds", () => {
    expect(() => pickMainBundleFile({ "funcs/x.py": FUNC })).toThrow(/no .mthds/i);
  });
  it("recognizes a quoted `main_pipe` TOML key (regex missed it, fell back to file order)", () => {
    const files = {
      "a_no_main.mthds": 'domain = "a"',
      "b_quoted.mthds": 'domain = "b"\n"main_pipe" = "run_b"',
    };
    expect(pickMainBundleFile(files)).toBe("b_quoted.mthds");
  });
  it("does not treat a `main_pipe` mention inside another value as a declaration", () => {
    // A commented-out / string-embedded mention is not a real top-level key.
    const files = {
      "real.mthds": 'domain = "r"\nmain_pipe = "go"',
      "decoy.mthds": 'domain = "d"\ndescription = "sets main_pipe = later"',
    };
    expect(pickMainBundleFile(files)).toBe("real.mthds");
  });
});

describe("materializeBundleFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-mat-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes files preserving subdirs and returns the main .mthds path", () => {
    const files = { "hostname_probe.mthds": MTHDS, "funcs/probe_host.py": FUNC };
    const mainPath = materializeBundleFiles(dir, files);
    expect(mainPath).toBe(join(dir, "hostname_probe.mthds"));
    expect(readFileSync(join(dir, "funcs", "probe_host.py"), "utf-8")).toBe(FUNC);
    expect(readFileSync(mainPath, "utf-8")).toBe(MTHDS);
  });

  it("rejects a key that escapes the target directory via `..` (no write outside)", () => {
    // Target a nested subdir so an escape lands under `dir` (auto-cleaned),
    // never in the shared tmpdir.
    const target = join(dir, "box");
    mkdirSync(target);
    const outside = join(target, "..", "escaped.py"); // → dir/escaped.py
    expect(() =>
      materializeBundleFiles(target, { "m.mthds": MTHDS, "../escaped.py": "pwned" }),
    ).toThrow(/not a tree path/);
    expect(() => readFileSync(outside, "utf-8")).toThrow();
  });

  it("rejects an absolute-path key pointing outside the target directory", () => {
    const target = join(dir, "box");
    mkdirSync(target);
    // Absolute, under `dir` (auto-cleaned) but NOT under `target`.
    const abs = join(dir, "abs-escape-target.py");
    expect(() => materializeBundleFiles(target, { "m.mthds": MTHDS, [abs]: "pwned" })).toThrow(
      /not a tree path/,
    );
    expect(() => readFileSync(abs, "utf-8")).toThrow();
  });

  it("honors an explicit `main` over the inferred pick", () => {
    // Both root .mthds declare main_pipe, so the inferred pick would take the
    // first; an explicit main must win so the caller's selection is respected.
    const files = {
      "method_a.mthds": 'domain = "a"\nmain_pipe = "run_a"',
      "method_b.mthds": 'domain = "b"\nmain_pipe = "run_b"',
    };
    expect(materializeBundleFiles(dir, files, "method_b.mthds")).toBe(join(dir, "method_b.mthds"));
    // An unknown main falls back to the inferred pick rather than a bogus path.
    expect(materializeBundleFiles(dir, files, "nope.mthds")).toBe(join(dir, "method_a.mthds"));
  });

  it("writes a Base64 entry's exact bytes", () => {
    const mainPath = materializeBundleFiles(dir, {
      "m.mthds": MTHDS,
      "images/logo.png": { base64: "iVBOR/8A" },
    });
    expect(mainPath).toBe(join(dir, "m.mthds"));
    expect([...readFileSync(join(dir, "images", "logo.png"))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0xff, 0x00,
    ]);
  });

  it("refuses a hash entry, which only a blob store resolves, before writing anything", () => {
    expect(() =>
      materializeBundleFiles(dir, {
        "m.mthds": MTHDS,
        "big.bin": { sha256: "a".repeat(64), size: 3 },
      }),
    ).toThrow(/no blob store/);
    expect(() => readFileSync(join(dir, "m.mthds"), "utf-8")).toThrow();
  });

  it("refuses a key that is not a tree path", () => {
    expect(() => materializeBundleFiles(dir, { "m.mthds": MTHDS, "a\\b.py": "x" })).toThrow(
      /not a tree path/,
    );
  });
});
