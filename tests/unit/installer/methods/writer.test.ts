import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// `renameSync` keeps its real behaviour, wrapped so a test can make one rename fail.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMethodFiles } from "../../../../src/installer/methods/writer.js";
import { ProblemError } from "../../../../src/problems/errors.js";
import type { MethodsFile, ResolvedRepo } from "../../../../src/package/manifest/types.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function makeRepo(names: string[], files: MethodsFile[] = []): ResolvedRepo {
  return {
    methods: names.map((name) => ({
      name,
      manifest: {
        package: {
          name,
          address: "github.com/test/repo",
          version: "1.0.0",
          description: "test",
        },
      },
      rawManifest: `[package]\nname = "${name}"\naddress = "github.com/test/repo"\nversion = "1.0.0"\ndescription = "test"`,
      files: files.length ? files : [{ path: "main.mthds", bytes: encode("test content") }],
    })),
    skipped: [],
    source: "local",
    repoName: "test-repo",
    isPublic: false,
  };
}

describe("writeMethodFiles path traversal checks", () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `mthds-writer-test-${Date.now()}`);
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects names that traverse outside targetDir", () => {
    const repo = makeRepo(["../../escape"]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).toThrow(
      /path traversal detected/i,
    );
  });

  it("rejects file paths that traverse outside installDir", () => {
    const repo = makeRepo(["legit-method"], [{ path: "../../escape.mthds", bytes: encode("bad") }]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).toThrow(
      /path traversal detected/i,
    );
  });

  it("works correctly when targetDir is relative", () => {
    // Save and change cwd to a temp dir so relative path resolves safely
    const originalCwd = process.cwd();
    process.chdir(testDir);

    try {
      const repo = makeRepo(["../../escape"]);

      expect(() => writeMethodFiles(repo, "methods")).toThrow(/path traversal detected/i);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // A name or a path the writer refuses is a fault of the method's package, which its owner fixes,
  // so the install reads it as that problem rather than as a write that failed.
  it.each([
    ["a name", ["../../escape"], undefined, { reason: "invalid_method_name" }],
    [
      "a file path",
      ["legit-method"],
      [{ path: "../../escape.mthds", bytes: encode("bad") }],
      { reason: "invalid_tree_path", path: "../../escape.mthds" },
    ],
  ])("refuses %s that escapes as method.package_invalid", (_topic, names, files, params) => {
    const repo = makeRepo(names, files);
    let thrown: unknown;
    try {
      writeMethodFiles(repo, join(testDir, "methods"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProblemError);
    expect((thrown as ProblemError).problem).toMatchObject({
      code: "method.package_invalid",
      params,
      next_step: { kind: "contact_owner" },
    });
  });

  it("allows valid names", () => {
    const repo = makeRepo(["valid-method"]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).not.toThrow();
  });

  it("refuses a path that is not a tree path before writing anything of the method", () => {
    const repo = makeRepo(["legit"], [{ path: "a\\b.py", bytes: encode("x") }]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).toThrow(/path traversal/i);
    expect(existsSync(join(testDir, "methods", "legit"))).toBe(false);
  });
});

describe("writeMethodFiles installs the whole tree", () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `mthds-writer-tree-test-${Date.now()}`);
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("writes every file of the tree with its exact bytes, the manifest among them", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const repo = makeRepo(
      ["demo"],
      [
        { path: "METHODS.toml", bytes: encode("[package]\nname = 'demo'\n") },
        { path: "bundle.mthds", bytes: encode("domain = 'demo'") },
        { path: "funcs/f.py", bytes: encode("def f(): ...\n") },
        { path: "images/logo.png", bytes: png },
      ],
    );
    const target = join(testDir, "methods");

    writeMethodFiles(repo, target);

    const installed = join(target, "demo");
    expect(readFileSync(join(installed, "METHODS.toml"), "utf-8")).toBe(
      "[package]\nname = 'demo'\n",
    );
    expect(readFileSync(join(installed, "funcs", "f.py"), "utf-8")).toBe("def f(): ...\n");
    expect([...readFileSync(join(installed, "images", "logo.png"))]).toEqual([...png]);
    // No scratch directory is left beside the installed methods.
    expect(readdirSync(target)).toEqual(["demo"]);
  });

  it("writes the manifest the resolver read when the tree leaves it out", () => {
    const repo = makeRepo(["demo"], [{ path: "bundle.mthds", bytes: encode("domain = 'demo'") }]);
    const target = join(testDir, "methods");

    writeMethodFiles(repo, target);

    expect(readFileSync(join(target, "demo", "METHODS.toml"), "utf-8")).toBe(
      repo.methods[0]!.rawManifest,
    );
  });

  it("replaces an earlier install, so a file the method no longer holds does not linger", () => {
    const target = join(testDir, "methods");
    mkdirSync(join(target, "demo", "funcs"), { recursive: true });
    writeFileSync(join(target, "demo", "funcs", "old.py"), "stale");

    writeMethodFiles(makeRepo(["demo"]), target);

    expect(existsSync(join(target, "demo", "funcs", "old.py"))).toBe(false);
    expect(readdirSync(join(target, "demo")).sort()).toEqual(["METHODS.toml", "main.mthds"]);
  });

  it("keeps the earlier install whole when moving the new one into place fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const target = join(testDir, "methods");
    const installed = join(target, "demo");
    mkdirSync(join(installed, "funcs"), { recursive: true });
    writeFileSync(join(installed, "funcs", "old.py"), "earlier");
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (String(to) === installed && String(from).includes(".installing-")) {
        if (!String(from).endsWith("-previous")) {
          throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
            code: "EXDEV",
          });
        }
      }
      actual.renameSync(from, to);
    });
    try {
      expect(() => writeMethodFiles(makeRepo(["demo"]), target)).toThrow(/EXDEV/);
    } finally {
      vi.mocked(renameSync).mockImplementation(actual.renameSync);
    }

    expect(readFileSync(join(installed, "funcs", "old.py"), "utf-8")).toBe("earlier");
    expect(existsSync(join(installed, "main.mthds"))).toBe(false);
    // Neither the new tree nor the backup is left beside the installed methods.
    expect(readdirSync(target)).toEqual(["demo"]);
  });
});
