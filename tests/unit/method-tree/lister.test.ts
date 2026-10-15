/**
 * What the corpus does not exercise of the lister: the limits a caller sets, what is read and what
 * is not, a manifest whose patterns cannot be read, and what a listed tree gives back.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listMethodTree,
  MethodTreeError,
  readFileEntryMap,
  TreeLimitExceededError,
} from "../../../src/method-tree/index.js";

const MANIFEST = `[package]\naddress = "github.com/acme/x"\nversion = "1.0.0"\ndescription = "x"\n`;

let workspace: string;

/** Whether the scratch directory's file system answers a name in another case. */
function probeCaseInsensitive(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "mthds-case-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "");
    return existsSync(join(probe, "PROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const CASE_INSENSITIVE = probeCaseInsensitive();
// A directory with no permission is still listable by the superuser.
const RUNS_AS_ROOT = process.getuid?.() === 0;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "mthds-lister-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer): void {
  const absolute = join(workspace, ...path.split("/"));
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

async function refusalOf(promise: Promise<unknown>): Promise<MethodTreeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MethodTreeError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("limits", () => {
  beforeEach(() => {
    write("METHODS.toml", MANIFEST);
    write("main.mthds", 'domain = "x"\n');
    write("data/a.bin", Buffer.alloc(600));
    write("data/b.bin", Buffer.alloc(600));
  });

  it("stops at the file count, naming the root, the limit and the count reached", async () => {
    const err = await refusalOf(listMethodTree(workspace, { limits: { maxFileCount: 2 } }));
    expect(err).toBeInstanceOf(TreeLimitExceededError);
    const limitError = err as TreeLimitExceededError;
    expect(limitError.code).toBe("limit_exceeded");
    expect(limitError.limit).toBe("maxFileCount");
    expect(limitError.maximum).toBe(2);
    expect(limitError.reached).toBe(3);
    expect(limitError.message).toContain(limitError.root);
  });

  it("stops at a file's size, naming the file", async () => {
    const err = (await refusalOf(
      listMethodTree(workspace, { limits: { maxFileSize: 500 } }),
    )) as TreeLimitExceededError;
    expect(err.limit).toBe("maxFileSize");
    expect(err.names).toEqual(["data/a.bin"]);
  });

  it("stops at the total size", async () => {
    const err = (await refusalOf(
      listMethodTree(workspace, { limits: { maxTotalSize: 1000 } }),
    )) as TreeLimitExceededError;
    expect(err.limit).toBe("maxTotalSize");
    expect(err.reached).toBeGreaterThan(1000);
  });

  it("lists a tree within its limits", async () => {
    const tree = await listMethodTree(workspace, {
      limits: { maxFileCount: 4, maxFileSize: 600, maxTotalSize: 2000 },
    });
    expect(tree.files.map((file) => file.path)).toEqual([
      "METHODS.toml",
      "data/a.bin",
      "data/b.bin",
      "main.mthds",
    ]);
  });
});

describe("what the walk reads", () => {
  it("refuses a .gitignore file that is not UTF-8, naming its path from the root", async () => {
    write("main.mthds", "x");
    write("docs/.gitignore", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const err = await refusalOf(listMethodTree(workspace));
    expect(err.code).toBe("gitignore_not_utf8");
    expect(err.names).toEqual(["docs/.gitignore"]);
  });

  it("never reads a .gitignore file inside an excluded directory", async () => {
    write("main.mthds", "x");
    write(".gitignore", "build/\n");
    write("build/.gitignore", Buffer.from([0xff, 0x0a]));
    write("node_modules/pkg/.gitignore", Buffer.from([0xff, 0x0a]));
    const tree = await listMethodTree(workspace);
    expect(tree.files.map((file) => file.path)).toEqual(["main.mthds"]);
  });

  it("skips a leading byte order mark", async () => {
    write("main.mthds", "x");
    write("debug.log", "x");
    write(".gitignore", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("*.log\n")]));
    const tree = await listMethodTree(workspace);
    expect(tree.files.map((file) => file.path)).toEqual(["main.mthds"]);
  });

  it("does not read a .gitignore that is a symbolic link", async () => {
    write("main.mthds", "x");
    write("debug.log", "x");
    write("patterns.txt", "*.log\n");
    symlinkSync("patterns.txt", join(workspace, ".gitignore"));
    const tree = await listMethodTree(workspace);
    expect(tree.files.map((file) => file.path)).toEqual([
      "debug.log",
      "main.mthds",
      "patterns.txt",
    ]);
  });

  it("refuses a manifest whose exclude patterns cannot be read", async () => {
    write("METHODS.toml", `${MANIFEST}exclude = "samples/"\n`);
    write("main.mthds", "x");
    const err = await refusalOf(listMethodTree(workspace));
    expect(err.code).toBe("manifest_invalid");
  });

  it("refuses a lone file that is not a .mthds file", async () => {
    write("notes.txt", "x");
    const err = await refusalOf(listMethodTree(join(workspace, "notes.txt")));
    expect(err.code).toBe("not_listable");
  });

  it("refuses a path that does not exist", async () => {
    const err = await refusalOf(listMethodTree(join(workspace, "missing")));
    expect(err.code).toBe("not_found");
  });
});

describe("a listed tree", () => {
  beforeEach(() => {
    write("METHODS.toml", MANIFEST);
    write("main.mthds", 'domain = "x"\n');
    write("logo.bin", Buffer.from([0x00, 0xff, 0x10]));
    write("sub/inner.mthds", 'domain = "y"\n');
  });

  it("finds the root above a directory handed over, unless told not to discover it", async () => {
    const discovered = await listMethodTree(join(workspace, "sub"));
    expect(discovered.files.map((file) => file.path)).toContain("sub/inner.mthds");
    const rooted = await listMethodTree(join(workspace, "sub"), { discover: false });
    expect(rooted.files.map((file) => file.path)).toEqual(["inner.mthds"]);
  });

  it("reads a file back, refusing it once changed", async () => {
    const tree = await listMethodTree(workspace);
    expect((await tree.readFile("main.mthds")).toString()).toBe('domain = "x"\n');
    write("main.mthds", 'domain = "z"\n');
    const err = await refusalOf(tree.readFile("main.mthds"));
    expect(err.names).toEqual(["main.mthds"]);
    await expect(tree.readFile("missing.txt")).rejects.toThrow(MethodTreeError);
  });

  it("travels as a map of file entries that reads back to the same digest", async () => {
    const tree = await listMethodTree(workspace);
    const entries = await tree.toMethodFiles();
    expect(entries["main.mthds"]).toBe('domain = "x"\n');
    expect(entries["logo.bin"]).toEqual({ base64: "AP8Q" });
    const read = await readFileEntryMap(JSON.stringify(entries));
    expect(read.digest).toBe(tree.digest);
  });

  it("names the rule and the directory keeping out a file a reference reaches", async () => {
    write("vendor/.git", "gitdir: nowhere\n");
    write("vendor/lib.py", "x");
    const tree = await listMethodTree(workspace);
    const resolution = await tree.resolveReference({
      holder: "main.mthds",
      reference: "vendor/lib.py",
      context: "path",
    });
    expect(resolution).toMatchObject({
      kind: "refused",
      refusal: {
        code: "reference_not_in_tree",
        resolved: "vendor/lib.py",
        excludedBy: "nested_repository",
        excludedDirectory: "vendor",
      },
    });
  });
});

describe("a tree's files as they travel", () => {
  it("round-trips a binary file of several megabytes through its map of file entries", async () => {
    write("main.mthds", 'domain = "x"\n');
    write("data/blob.bin", Buffer.alloc(6 * 1024 * 1024, 0xff));
    const tree = await listMethodTree(workspace);
    const entries = await tree.toMethodFiles();
    expect(entries["data/blob.bin"]).toHaveProperty("base64");
    const read = await readFileEntryMap(JSON.stringify(entries));
    expect(read.digest).toBe(tree.digest);
  });

  it("keeps a file named __proto__, as text and in Base64", async () => {
    write("main.mthds", "x");
    write("__proto__", "text\n");
    write("data/__proto__", Buffer.from([0xff, 0x00]));
    const tree = await listMethodTree(workspace);
    const entries = await tree.toMethodFiles();
    expect(Object.getPrototypeOf(entries)).toBe(Object.prototype);
    expect(Object.keys(entries).sort()).toEqual(["__proto__", "data/__proto__", "main.mthds"]);
    expect(Object.getOwnPropertyDescriptor(entries, "__proto__")?.value).toBe("text\n");
    expect(Object.getOwnPropertyDescriptor(entries, "data/__proto__")?.value).toEqual({
      base64: "/wA=",
    });
    const read = await readFileEntryMap(JSON.stringify(entries));
    expect(read.files.map((file) => file.path)).toEqual([
      "__proto__",
      "data/__proto__",
      "main.mthds",
    ]);
    expect(read.digest).toBe(tree.digest);
  });
});

describe.skipIf(RUNS_AS_ROOT)("a directory that cannot be listed", () => {
  /** Run `body` with the directory at `path` unreadable, restoring it whatever happens. */
  async function whileUnreadable(path: string, body: () => Promise<void>): Promise<void> {
    const absolute = join(workspace, ...path.split("/"));
    chmodSync(absolute, 0o000);
    try {
      await body();
    } finally {
      chmodSync(absolute, 0o755);
    }
  }

  it("is pruned when a .gitignore file excludes it", async () => {
    write("main.mthds", "x");
    write(".gitignore", "private/\n");
    write("private/secret.txt", "x");
    await whileUnreadable("private", async () => {
      const tree = await listMethodTree(workspace);
      expect(tree.files.map((file) => file.path)).toEqual(["main.mthds"]);
    });
  });

  it("is pruned when the manifest's exclude patterns exclude it", async () => {
    write("METHODS.toml", `${MANIFEST}exclude = ["private/"]\n`);
    write("main.mthds", "x");
    write("private/secret.txt", "x");
    await whileUnreadable("private", async () => {
      const tree = await listMethodTree(workspace);
      expect(tree.files.map((file) => file.path)).toEqual(["METHODS.toml", "main.mthds"]);
    });
  });

  it("refuses the tree when no rule excludes it", async () => {
    write("main.mthds", "x");
    write("private/secret.txt", "x");
    await whileUnreadable("private", async () => {
      const err = await refusalOf(listMethodTree(workspace));
      expect(err.code).toBe("not_listable");
    });
  });

  it("still names a marker inside an excluded directory it can list", async () => {
    write("main.mthds", "x");
    write(".gitignore", "vendor/\n");
    write("vendor/.git", "gitdir: nowhere\n");
    write("vendor/lib.py", "x");
    const tree = await listMethodTree(workspace);
    const resolution = await tree.resolveReference({
      holder: "main.mthds",
      reference: "vendor/lib.py",
      context: "path",
    });
    expect(resolution).toMatchObject({
      refusal: { excludedBy: "nested_repository", excludedDirectory: "vendor" },
    });
  });
});

describe.skipIf(!CASE_INSENSITIVE)("a lone file named in another case", () => {
  it("takes the name the file system holds", async () => {
    write("main.mthds", 'domain = "x"\n');
    const typed = await listMethodTree(join(workspace, "MAIN.mthds"));
    const exact = await listMethodTree(join(workspace, "main.mthds"));
    expect(typed.entry).toBe("main.mthds");
    expect(typed.files.map((file) => file.path)).toEqual(["main.mthds"]);
    expect(typed.digest).toBe(exact.digest);
  });

  it("names its entry as the tree holds it under a manifest", async () => {
    write("METHODS.toml", MANIFEST);
    write("bundles/flow.mthds", "x");
    const tree = await listMethodTree(join(workspace, "BUNDLES", "FLOW.mthds"));
    expect(tree.entry).toBe("bundles/flow.mthds");
  });

  it("checks the suffix on the name the file system holds", async () => {
    write("flow.MTHDS", "x");
    const err = await refusalOf(listMethodTree(join(workspace, "flow.mthds")));
    expect(err.code).toBe("not_listable");
  });
});

describe("a file changed after the tree was listed", () => {
  beforeEach(() => {
    write("main.mthds", 'domain = "x"\n');
    write("other.txt", "other\n");
  });

  it("is refused as a link when it became one, the link never followed", async () => {
    const tree = await listMethodTree(workspace);
    unlinkSync(join(workspace, "main.mthds"));
    symlinkSync("other.txt", join(workspace, "main.mthds"));
    const err = await refusalOf(tree.readFile("main.mthds"));
    expect(err.code).toBe("symbolic_link");
    expect(err.names).toEqual(["main.mthds"]);
  });

  it("is refused as a special file when it became a named pipe, without blocking", async (context) => {
    const tree = await listMethodTree(workspace);
    unlinkSync(join(workspace, "main.mthds"));
    try {
      execFileSync("mkfifo", [join(workspace, "main.mthds")], { stdio: "ignore" });
    } catch {
      context.skip();
    }
    const err = await refusalOf(tree.readFile("main.mthds"));
    expect(err.code).toBe("special_file");
  });

  it("is refused as a MethodTreeError when it is gone or became a directory", async () => {
    const tree = await listMethodTree(workspace);
    unlinkSync(join(workspace, "main.mthds"));
    const gone = await refusalOf(tree.readFile("main.mthds"));
    expect(gone.code).toBe("not_listable");
    expect(gone.names).toEqual(["main.mthds"]);
    mkdirSync(join(workspace, "main.mthds"));
    const directory = await refusalOf(tree.readFile("main.mthds"));
    expect(directory.code).toBe("not_listable");
  });
});

describe("a reference into an excluded link", () => {
  it("is not followed to find the file it names", async () => {
    const outside = mkdtempSync(join(tmpdir(), "mthds-outside-"));
    try {
      writeFileSync(join(outside, "a.txt"), "x");
      write("main.mthds", "x");
      write(".gitignore", "linked\n");
      symlinkSync(outside, join(workspace, "linked"));
      const tree = await listMethodTree(workspace);
      const resolution = await tree.resolveReference({
        holder: "main.mthds",
        reference: "linked/a.txt",
        context: "path",
      });
      expect(resolution).toMatchObject({
        kind: "refused",
        refusal: { code: "reference_not_in_tree", resolved: "linked/a.txt" },
      });
      if (resolution.kind === "refused") expect(resolution.refusal.excludedBy).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
