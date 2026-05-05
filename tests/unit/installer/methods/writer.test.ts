import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeMethodFiles } from "../../../../src/installer/methods/writer.js";
import type { ResolvedRepo } from "../../../../src/package/manifest/types.js";

function makeRepo(names: string[], files: { relativePath: string; content: string }[] = []): ResolvedRepo {
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
      files: files.length ? files : [{ relativePath: "main.mthds", content: "test content" }],
    })),
    skipped: [],
    source: "local",
    repoName: "test-repo",
    isPublic: false,
  };
}

describe("writeMethodFiles path traversal checks", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mthds-writer-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects names that traverse outside targetDir", () => {
    const repo = makeRepo(["../../escape"]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).toThrow(/path traversal detected/i);
  });

  it("rejects file paths that traverse outside installDir", () => {
    const repo = makeRepo(["legit-method"], [
      { relativePath: "../../escape.mthds", content: "bad" },
    ]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).toThrow(/path traversal detected/i);
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

  it("allows valid names", () => {
    const repo = makeRepo(["valid-method"]);

    expect(() => writeMethodFiles(repo, join(testDir, "methods"))).not.toThrow();
  });
});
