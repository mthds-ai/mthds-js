/**
 * What a `run` or `validate` command line sends: one method tree, and the bundle it named in it
 * (`src/runners/method-target.ts`).
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INLINE_CONTENT_TREE_PATH,
  MethodTargetError,
  resolveMethodTarget,
} from "../../../src/runners/method-target.js";
import { TreeLimitExceededError } from "../../../src/method-tree/exceptions.js";

let scratch: string;

function write(relative: string, content: string): string {
  const path = join(scratch, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function treePaths(resolved: Awaited<ReturnType<typeof resolveMethodTarget>>): string[] {
  if (!("tree" in resolved.method)) throw new Error("expected a tree");
  return resolved.method.tree.files.map((file) => file.path);
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "mthds-method-target-")));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolveMethodTarget", () => {
  it("lists a directory as its tree, with no entry", async () => {
    write("m/bundle.mthds", "domain = 'm'\nmain_pipe = 'run'\n");
    write("m/funcs/f.py", "def f(): ...\n");
    const resolved = await resolveMethodTarget({ path: join(scratch, "m") }, []);
    expect(treePaths(resolved)).toEqual(["bundle.mthds", "funcs/f.py"]);
    expect(resolved.entry).toBeNull();
    expect(resolved.entryMainPipe).toBeUndefined();
  });

  it("sends a .mthds file alone, with no manifest above it, as a one-file tree", async () => {
    const file = write("m/child.mthds", "domain = 'm'\nmain_pipe = 'child_run'\n");
    write("m/funcs/f.py", "def f(): ...\n");
    const resolved = await resolveMethodTarget({ path: file }, []);
    expect(treePaths(resolved)).toEqual(["child.mthds"]);
    expect(resolved.entry).toBe("child.mthds");
    expect(resolved.entryMainPipe).toBe("child_run");
  });

  it("sends a .mthds file under a METHODS.toml in its manifest's tree, the file as entry", async () => {
    write("pkg/METHODS.toml", "[package]\nname = 'pkg'\n");
    write("pkg/bundle.mthds", "domain = 'pkg'\n");
    const file = write("pkg/steps/step.mthds", "domain = 'pkg'\nmain_pipe = 'step'\n");
    const resolved = await resolveMethodTarget({ path: file }, [join(scratch, "pkg")]);
    expect(treePaths(resolved)).toEqual(["METHODS.toml", "bundle.mthds", "steps/step.mthds"]);
    expect(resolved.entry).toBe("steps/step.mthds");
    expect(resolved.entryMainPipe).toBe("step");
  });

  it("roots a lone file at a library directory holding it, so the files beside it travel", async () => {
    const file = write("m/sub/child.mthds", "domain = 'm'\nmain_pipe = 'child_run'\n");
    write("m/root.mthds", "domain = 'm'\n");
    write("m/funcs/f.py", "def f(): ...\n");
    const resolved = await resolveMethodTarget({ path: file }, [join(scratch, "m")]);
    expect(treePaths(resolved)).toEqual(["funcs/f.py", "root.mthds", "sub/child.mthds"]);
    expect(resolved.entry).toBe("sub/child.mthds");
  });

  it("refuses a library directory outside the tree's root", async () => {
    write("m/bundle.mthds", "domain = 'm'\n");
    write("lib/other.mthds", "domain = 'lib'\n");
    await expect(
      resolveMethodTarget({ path: join(scratch, "m") }, [join(scratch, "lib")]),
    ).rejects.toThrow(MethodTargetError);
  });

  it("refuses a library directory that does not hold a lone file", async () => {
    const file = write("m/bundle.mthds", "domain = 'm'\n");
    write("lib/other.mthds", "domain = 'lib'\n");
    await expect(resolveMethodTarget({ path: file }, [join(scratch, "lib")])).rejects.toThrow(
      /named alone/,
    );
  });

  it("stops listing at the first limit passed", async () => {
    write("m/bundle.mthds", "domain = 'm'\n");
    write("m/a.txt", "a");
    write("m/b.txt", "b");
    await expect(
      resolveMethodTarget({ path: join(scratch, "m") }, [], { maxFileCount: 2 }),
    ).rejects.toThrow(TreeLimitExceededError);
  });

  it("refuses a file that is not a .mthds file as the command line's mistake", async () => {
    const notes = write("notes.txt", "not a bundle");
    await expect(resolveMethodTarget({ path: notes }, [])).rejects.toThrow(MethodTargetError);
  });

  it("refuses a tree holding no .mthds file", async () => {
    write("m/README.md", "nothing to run");
    await expect(resolveMethodTarget({ path: join(scratch, "m") }, [])).rejects.toThrow(
      /holds no \.mthds file/,
    );
  });

  it("sends inline content as a one-file tree of its own, and refuses a library directory with it", async () => {
    const resolved = await resolveMethodTarget({ content: "domain = 'x'\nmain_pipe = 'go'\n" }, []);
    expect(resolved.method).toEqual({
      files: { [INLINE_CONTENT_TREE_PATH]: "domain = 'x'\nmain_pipe = 'go'\n" },
    });
    expect(resolved.entry).toBe(INLINE_CONTENT_TREE_PATH);
    expect(resolved.entryMainPipe).toBe("go");
    await expect(resolveMethodTarget({ content: "domain = 'x'" }, [scratch])).rejects.toThrow(
      MethodTargetError,
    );
  });
});
