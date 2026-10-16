import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeMethodFiles } from "../../../src/runners/bundle.js";

const MTHDS = [
  'domain      = "pf_hostname_probe"',
  'main_pipe   = "probe_host"',
  "[pipe.probe_host]",
  'type          = "PipeFunc"',
  'function_name = "probe_host"',
].join("\n");

const FUNC = "@pipe_func(name='probe_host')\nasync def probe_host(): ...\n";

describe("materializeMethodFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-mat-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes every file of the tree into the directory, preserving subdirs", () => {
    const files = { "hostname_probe.mthds": MTHDS, "funcs/probe_host.py": FUNC };
    const target = join(dir, "method");
    expect(materializeMethodFiles(target, files)).toBeUndefined();
    expect(readFileSync(join(target, "funcs", "probe_host.py"), "utf-8")).toBe(FUNC);
    expect(readFileSync(join(target, "hostname_probe.mthds"), "utf-8")).toBe(MTHDS);
    expect(readdirSync(target).sort()).toEqual(["funcs", "hostname_probe.mthds"]);
  });

  it("rejects a key that escapes the target directory via `..` (no write outside)", () => {
    // Target a nested subdir so an escape lands under `dir` (auto-cleaned),
    // never in the shared tmpdir.
    const target = join(dir, "box");
    mkdirSync(target);
    const outside = join(target, "..", "escaped.py"); // → dir/escaped.py
    expect(() =>
      materializeMethodFiles(target, { "m.mthds": MTHDS, "../escaped.py": "pwned" }),
    ).toThrow(/not a tree path/);
    expect(() => readFileSync(outside, "utf-8")).toThrow();
  });

  it("rejects an absolute-path key pointing outside the target directory", () => {
    const target = join(dir, "box");
    mkdirSync(target);
    // Absolute, under `dir` (auto-cleaned) but NOT under `target`.
    const abs = join(dir, "abs-escape-target.py");
    expect(() => materializeMethodFiles(target, { "m.mthds": MTHDS, [abs]: "pwned" })).toThrow(
      /not a tree path/,
    );
    expect(() => readFileSync(abs, "utf-8")).toThrow();
  });

  it("writes a Base64 entry's exact bytes, including a Base64 bundle", () => {
    materializeMethodFiles(dir, {
      "m.mthds": { base64: Buffer.from(MTHDS, "utf-8").toString("base64") },
      "images/logo.png": { base64: "iVBOR/8A" },
    });
    expect(readFileSync(join(dir, "m.mthds"), "utf-8")).toBe(MTHDS);
    expect([...readFileSync(join(dir, "images", "logo.png"))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0xff, 0x00,
    ]);
  });

  it("refuses a hash entry, which only a blob store resolves, before writing anything", () => {
    expect(() =>
      materializeMethodFiles(dir, {
        "m.mthds": MTHDS,
        "big.bin": { sha256: "a".repeat(64), size: 3 },
      }),
    ).toThrow(/no blob store/);
    expect(() => readFileSync(join(dir, "m.mthds"), "utf-8")).toThrow();
  });

  it("refuses a key that is not a tree path", () => {
    expect(() => materializeMethodFiles(dir, { "m.mthds": MTHDS, "a\\b.py": "x" })).toThrow(
      /not a tree path/,
    );
  });
});
