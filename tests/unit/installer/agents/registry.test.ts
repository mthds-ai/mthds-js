import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

// We need to test writeMethodFiles indirectly via the exported agent handlers
import { getAgentHandler } from "../../../../src/installer/agents/registry.js";
import type { ResolvedRepo } from "../../../../src/package/manifest/types.js";

function makeRepo(slugs: string[], files: { relativePath: string; content: string }[] = []): ResolvedRepo {
  return {
    methods: slugs.map((slug) => ({
      slug,
      manifest: {
        package: {
          address: "github.com/test/repo",
          version: "1.0.0",
          description: "test",
        },
      },
      rawManifest: "[package]\naddress = \"github.com/test/repo\"\nversion = \"1.0.0\"\ndescription = \"test\"",
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
    testDir = join(tmpdir(), `mthds-registry-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects slugs that traverse outside targetDir", async () => {
    const handler = getAgentHandler("claude-code");
    const repo = makeRepo(["../../escape"]);

    await expect(
      handler.installMethod({
        repo,
        agent: "claude-code",
        location: "local" as any,
        targetDir: join(testDir, "methods"),
      })
    ).rejects.toThrow(/path traversal detected/i);
  });

  it("rejects file paths that traverse outside installDir", async () => {
    const handler = getAgentHandler("claude-code");
    const repo = makeRepo(["legit-method"], [
      { relativePath: "../../escape.mthds", content: "bad" },
    ]);

    await expect(
      handler.installMethod({
        repo,
        agent: "claude-code",
        location: "local" as any,
        targetDir: join(testDir, "methods"),
      })
    ).rejects.toThrow(/path traversal detected/i);
  });

  it("works correctly when targetDir is relative", async () => {
    // Save and change cwd to a temp dir so relative path resolves safely
    const originalCwd = process.cwd();
    process.chdir(testDir);

    try {
      const handler = getAgentHandler("claude-code");
      const repo = makeRepo(["../../escape"]);

      await expect(
        handler.installMethod({
          repo,
          agent: "claude-code",
          location: "local" as any,
          targetDir: "methods",
        })
      ).rejects.toThrow(/path traversal detected/i);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("allows valid slugs", async () => {
    const handler = getAgentHandler("claude-code");
    const repo = makeRepo(["valid-method"]);

    await expect(
      handler.installMethod({
        repo,
        agent: "claude-code",
        location: "local" as any,
        targetDir: join(testDir, "methods"),
      })
    ).resolves.toBeUndefined();
  });
});
