import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BundleTargetError, resolveBundleClosure } from "../../../src/runners/bundle.js";

// A method split across files, the way stepwise design writes it: a root bundle
// declaring the main pipe, and one file per refinement using the root's concepts.
const ROOT = 'domain = "demo"\nmain_pipe = "main"\n';
const CHILD = 'domain = "demo"\n[pipe.step]\ntype = "PipeLLM"\n';
const SHARED = 'domain = "shared"\n';

describe("resolveBundleClosure", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-closure-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends every .mthds file of a directory target, its main file first", () => {
    const bundleDir = join(dir, "method");
    mkdirSync(join(bundleDir, "steps"), { recursive: true });
    writeFileSync(join(bundleDir, "a_child.mthds"), CHILD);
    writeFileSync(join(bundleDir, "bundle.mthds"), ROOT);
    writeFileSync(join(bundleDir, "steps", "deep.mthds"), CHILD);
    writeFileSync(join(bundleDir, "METHODS.toml"), "[package]\n");
    writeFileSync(join(bundleDir, "funcs.py"), "pass\n");

    const closure = resolveBundleClosure({ path: bundleDir });

    expect(closure.entryNamed).toBe(false);
    expect(closure.files.map((file) => file.source)).toEqual([
      join(bundleDir, "bundle.mthds"),
      join(bundleDir, "a_child.mthds"),
      join(bundleDir, "steps", "deep.mthds"),
    ]);
    expect(closure.files[0]!.content).toBe(ROOT);
  });

  it("skips hidden and dependency directories, as the run bundle does", () => {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "bundle.mthds"), ROOT);
    writeFileSync(join(dir, ".git", "stray.mthds"), CHILD);
    writeFileSync(join(dir, "node_modules", "stray.mthds"), CHILD);

    const closure = resolveBundleClosure({ path: dir });

    expect(closure.files.map((file) => file.source)).toEqual([join(dir, "bundle.mthds")]);
  });

  it("sends a named file alone, leaving its siblings to the library directories", () => {
    writeFileSync(join(dir, "bundle.mthds"), ROOT);
    writeFileSync(join(dir, "child.mthds"), CHILD);

    const closure = resolveBundleClosure({ path: join(dir, "child.mthds") });

    expect(closure.entryNamed).toBe(true);
    expect(closure.files).toEqual([{ content: CHILD, source: join(dir, "child.mthds") }]);
  });

  it("adds a library directory's files once, keeping the named file first", () => {
    const method = join(dir, "method");
    const shared = join(dir, "shared");
    mkdirSync(method);
    mkdirSync(shared);
    writeFileSync(join(method, "bundle.mthds"), ROOT);
    writeFileSync(join(method, "child.mthds"), CHILD);
    writeFileSync(join(shared, "shared.mthds"), SHARED);

    // The hook's shape: the file, and its own directory as a library directory.
    const closure = resolveBundleClosure({ path: join(method, "child.mthds") }, [
      `${method}/`,
      shared,
    ]);

    expect(closure.files.map((file) => file.source)).toEqual([
      join(method, "child.mthds"),
      join(method, "bundle.mthds"),
      join(shared, "shared.mthds"),
    ]);
    expect(closure.files.map((file) => file.content)).toEqual([CHILD, ROOT, SHARED]);
  });

  it("puts inline content first, with no source, beside the library directories", () => {
    writeFileSync(join(dir, "child.mthds"), CHILD);

    const closure = resolveBundleClosure({ content: ROOT }, [dir]);

    expect(closure.entryNamed).toBe(true);
    expect(closure.files).toEqual([
      { content: ROOT },
      { content: CHILD, source: join(dir, "child.mthds") },
    ]);
  });

  it("refuses a directory holding no .mthds file", () => {
    writeFileSync(join(dir, "notes.txt"), "nothing here");

    expect(() => resolveBundleClosure({ path: dir })).toThrow(BundleTargetError);
    expect(() => resolveBundleClosure({ path: dir })).toThrow(/No \.mthds file found/);
  });

  it("refuses a file that is not a .mthds file", () => {
    writeFileSync(join(dir, "inputs.json"), "{}");

    expect(() => resolveBundleClosure({ path: join(dir, "inputs.json") })).toThrow(
      BundleTargetError,
    );
  });

  it("lets a missing target or library directory fail as a filesystem error", () => {
    writeFileSync(join(dir, "bundle.mthds"), ROOT);

    expect(() => resolveBundleClosure({ path: join(dir, "missing.mthds") })).toThrow(/ENOENT/);
    expect(() =>
      resolveBundleClosure({ path: join(dir, "bundle.mthds") }, [join(dir, "nowhere")]),
    ).toThrow(/ENOENT/);
  });
});
