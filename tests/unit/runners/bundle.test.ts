import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectBundleFiles,
  hasCustomPython,
  pickMainBundleFile,
  materializeBundleFiles,
  resolveRunBundle,
} from "../../../src/runners/bundle.js";

const MTHDS = [
  'domain      = "pf_hostname_probe"',
  'main_pipe   = "probe_host"',
  "[pipe.probe_host]",
  'type          = "PipeFunc"',
  'function_name = "probe_host"',
].join("\n");

const FUNC = "@pipe_func(name='probe_host')\nasync def probe_host(): ...\n";

describe("bundle collection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects the .mthds and funcs/*.py with POSIX relative paths", () => {
    writeFileSync(join(dir, "hostname_probe.mthds"), MTHDS, "utf-8");
    mkdirSync(join(dir, "funcs"));
    writeFileSync(join(dir, "funcs", "probe_host.py"), FUNC, "utf-8");

    const files = collectBundleFiles(dir);
    expect(Object.keys(files).sort()).toEqual(["funcs/probe_host.py", "hostname_probe.mthds"]);
    expect(files["funcs/probe_host.py"]).toBe(FUNC);
  });

  it("includes requirements.txt and skips __pycache__ / hidden dirs", () => {
    writeFileSync(join(dir, "m.mthds"), MTHDS, "utf-8");
    writeFileSync(join(dir, "requirements.txt"), "pandas\n", "utf-8");
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "junk.py"), "x", "utf-8");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config.py"), "x", "utf-8");

    const files = collectBundleFiles(dir);
    expect(Object.keys(files).sort()).toEqual(["m.mthds", "requirements.txt"]);
  });

  it("excludes non-bundle files (json, md, images)", () => {
    writeFileSync(join(dir, "m.mthds"), MTHDS, "utf-8");
    writeFileSync(join(dir, "inputs.json"), "{}", "utf-8");
    writeFileSync(join(dir, "README.md"), "# x", "utf-8");

    expect(Object.keys(collectBundleFiles(dir))).toEqual(["m.mthds"]);
  });
});

describe("hasCustomPython", () => {
  it("is true when a .py is present", () => {
    expect(hasCustomPython({ "m.mthds": MTHDS, "funcs/x.py": FUNC })).toBe(true);
  });
  it("is true when requirements.txt is present", () => {
    expect(hasCustomPython({ "m.mthds": MTHDS, "requirements.txt": "pandas" })).toBe(true);
  });
  it("is false for a pure .mthds bundle", () => {
    expect(hasCustomPython({ "m.mthds": MTHDS })).toBe(false);
  });
});

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
});

describe("resolveRunBundle", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-resolve-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("directory target → files map", () => {
    writeFileSync(join(dir, "hostname_probe.mthds"), MTHDS, "utf-8");
    mkdirSync(join(dir, "funcs"));
    writeFileSync(join(dir, "funcs", "probe_host.py"), FUNC, "utf-8");

    const resolved = resolveRunBundle(dir);
    expect(resolved.mthds_contents).toBeUndefined();
    expect(Object.keys(resolved.files ?? {}).sort()).toEqual([
      "funcs/probe_host.py",
      "hostname_probe.mthds",
    ]);
  });

  it(".mthds file with sibling funcs/ → files map", () => {
    const mthdsPath = join(dir, "hostname_probe.mthds");
    writeFileSync(mthdsPath, MTHDS, "utf-8");
    mkdirSync(join(dir, "funcs"));
    writeFileSync(join(dir, "funcs", "probe_host.py"), FUNC, "utf-8");

    const resolved = resolveRunBundle(mthdsPath);
    expect(resolved.mthds_contents).toBeUndefined();
    expect(resolved.files?.["funcs/probe_host.py"]).toBe(FUNC);
  });

  it("plain .mthds file (no custom Python) → mthds_contents", () => {
    const mthdsPath = join(dir, "pure.mthds");
    writeFileSync(mthdsPath, MTHDS, "utf-8");

    const resolved = resolveRunBundle(mthdsPath);
    expect(resolved.files).toBeUndefined();
    expect(resolved.mthds_contents).toEqual([MTHDS]);
  });

  it("directory with no .mthds → throws", () => {
    mkdirSync(join(dir, "funcs"));
    writeFileSync(join(dir, "funcs", "x.py"), FUNC, "utf-8");
    expect(() => resolveRunBundle(dir)).toThrow(/no .mthds/i);
  });

  it("missing target → throws", () => {
    expect(() => resolveRunBundle(join(dir, "nope"))).toThrow();
  });
});
