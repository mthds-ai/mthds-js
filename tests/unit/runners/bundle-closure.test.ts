import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BundleTargetError, resolveBundleClosure } from "../../../src/runners/bundle.js";

// A method split across files, the way stepwise design writes it: a root bundle
// declaring the main pipe, and one file per refinement using the root's concepts.
const ROOT = 'domain = "demo"\nmain_pipe = "main"\n';
const CHILD = 'domain = "demo"\n[pipe.step]\ntype = "PipeLLM"\n';
const SHARED = 'domain = "shared"\n';

// A folder its owner cannot list stays listable by root, and Windows has no such mode.
const canLockFolders = process.platform !== "win32" && process.getuid?.() !== 0;

describe("resolveBundleClosure", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-closure-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends every .mthds file of a directory target, its bundle.mthds first", () => {
    const bundleDir = join(dir, "method");
    mkdirSync(join(bundleDir, "steps"), { recursive: true });
    writeFileSync(join(bundleDir, "a_child.mthds"), CHILD);
    writeFileSync(join(bundleDir, "bundle.mthds"), ROOT);
    writeFileSync(join(bundleDir, "steps", "deep.mthds"), CHILD);
    writeFileSync(join(bundleDir, "METHODS.toml"), "[package]\n");
    writeFileSync(join(bundleDir, "funcs.py"), "pass\n");

    const closure = resolveBundleClosure({ path: bundleDir });

    expect(closure.files.map((file) => file.source)).toEqual([
      join(bundleDir, "bundle.mthds"),
      join(bundleDir, "a_child.mthds"),
      join(bundleDir, "steps", "deep.mthds"),
    ]);
    expect(closure.files[0]!.content).toBe(ROOT);
  });

  it("takes bundle.mthds as the entry even when another root file declares a main_pipe", () => {
    writeFileSync(join(dir, "a_flow.mthds"), 'domain = "flow"\nmain_pipe = "flow"\n');
    writeFileSync(join(dir, "bundle.mthds"), ROOT);

    const closure = resolveBundleClosure({ path: dir });

    expect(closure.files.map((file) => file.source)).toEqual([
      join(dir, "bundle.mthds"),
      join(dir, "a_flow.mthds"),
    ]);
  });

  it("takes the only root file as the entry when there is no bundle.mthds", () => {
    mkdirSync(join(dir, "steps"));
    writeFileSync(join(dir, "steps", "a_step.mthds"), CHILD);
    writeFileSync(join(dir, "method.mthds"), ROOT);

    const closure = resolveBundleClosure({ path: dir });

    expect(closure.files.map((file) => file.source)).toEqual([
      join(dir, "method.mthds"),
      join(dir, "steps", "a_step.mthds"),
    ]);
  });

  it("refuses several root files and no bundle.mthds, as the pipelex runner does", () => {
    writeFileSync(join(dir, "one.mthds"), ROOT);
    writeFileSync(join(dir, "two.mthds"), CHILD);

    expect(() => resolveBundleClosure({ path: dir })).toThrow(BundleTargetError);
    expect(() => resolveBundleClosure({ path: dir })).toThrow(/one\.mthds, two\.mthds/);
  });

  it("refuses a directory whose .mthds files are all below its root", () => {
    mkdirSync(join(dir, "steps"));
    writeFileSync(join(dir, "steps", "a_step.mthds"), CHILD);

    expect(() => resolveBundleClosure({ path: dir })).toThrow(/at the root of bundle directory/);
  });

  it("refuses a bundle.mthds that is a symbolic link", () => {
    const store = join(dir, "store");
    const method = join(dir, "method");
    mkdirSync(store);
    mkdirSync(method);
    writeFileSync(join(store, "real.mthds"), ROOT);
    symlinkSync(join(store, "real.mthds"), join(method, "bundle.mthds"));
    writeFileSync(join(method, "child.mthds"), CHILD);

    expect(() => resolveBundleClosure({ path: method })).toThrow(/symbolic link/);
  });

  it("skips the directories pipelex's library scan skips, and only those", () => {
    writeFileSync(join(dir, "bundle.mthds"), ROOT);
    for (const skipped of [".git", ".venv", "venv", "env", "node_modules", "results"]) {
      mkdirSync(join(dir, skipped, "lib"), { recursive: true });
      writeFileSync(join(dir, skipped, "lib", "stray.mthds"), CHILD);
    }
    // Pipelex loads a hidden directory its list does not name, so the closure sends it too.
    mkdirSync(join(dir, ".methods"));
    writeFileSync(join(dir, ".methods", "kept.mthds"), CHILD);

    const closure = resolveBundleClosure({ path: dir });

    expect(closure.files.map((file) => file.source)).toEqual([
      join(dir, "bundle.mthds"),
      join(dir, ".methods", "kept.mthds"),
    ]);
  });

  it("skips them under a library directory too", () => {
    const method = join(dir, "method");
    mkdirSync(join(method, "venv"), { recursive: true });
    writeFileSync(join(method, "bundle.mthds"), ROOT);
    writeFileSync(join(method, "venv", "stray.mthds"), CHILD);

    const closure = resolveBundleClosure({ path: join(method, "bundle.mthds") }, [method]);

    expect(closure.files.map((file) => file.source)).toEqual([join(method, "bundle.mthds")]);
  });

  it.skipIf(!canLockFolders)(
    "skips a folder below a target or library directory that this user may not list",
    () => {
      const method = join(dir, "method");
      mkdirSync(join(method, "pgdata"), { recursive: true });
      writeFileSync(join(method, "bundle.mthds"), ROOT);
      writeFileSync(join(method, "child.mthds"), CHILD);
      writeFileSync(join(method, "pgdata", "stray.mthds"), CHILD);
      chmodSync(join(method, "pgdata"), 0o000);
      try {
        const expected = [join(method, "bundle.mthds"), join(method, "child.mthds")];
        // The hook's shape, and a directory target: pipelex's scan skips the folder in both.
        const fromLibrary = resolveBundleClosure({ path: join(method, "bundle.mthds") }, [method]);
        expect(fromLibrary.files.map((file) => file.source)).toEqual(expected);
        const fromDirectory = resolveBundleClosure({ path: method });
        expect(fromDirectory.files.map((file) => file.source)).toEqual(expected);
      } finally {
        chmodSync(join(method, "pgdata"), 0o755);
      }
    },
  );

  it.skipIf(!canLockFolders)(
    "lets a library directory this user may not list fail as a filesystem error",
    () => {
      const shared = join(dir, "shared");
      mkdirSync(shared);
      writeFileSync(join(dir, "bundle.mthds"), ROOT);
      chmodSync(shared, 0o000);
      try {
        expect(() => resolveBundleClosure({ path: join(dir, "bundle.mthds") }, [shared])).toThrow(
          /EACCES/,
        );
      } finally {
        chmodSync(shared, 0o755);
      }
    },
  );

  it("sends a named file alone, leaving its siblings to the library directories", () => {
    writeFileSync(join(dir, "bundle.mthds"), ROOT);
    writeFileSync(join(dir, "child.mthds"), CHILD);

    const closure = resolveBundleClosure({ path: join(dir, "child.mthds") });

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
