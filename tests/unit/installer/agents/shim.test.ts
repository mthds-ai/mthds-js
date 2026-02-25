import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { generateShim } from "../../../../src/installer/agents/registry.js";

describe("generateShim", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    // Use a temp directory as HOME to avoid polluting the real ~/.mthds/bin
    tempHome = mkdtempSync(join(tmpdir(), "mthds-shim-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("creates a shim file with correct content", () => {
    const installDir = "/path/to/methods/extract-terms";
    generateShim("extract-terms", installDir);

    const shimPath = join(tempHome, ".mthds", "bin", "extract-terms");
    const content = readFileSync(shimPath, "utf-8");

    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("exec pipelex-agent run pipe");
    expect(content).toContain(installDir);
    expect(content).toContain("-L");
  });

  it("uses the slug as the filename", () => {
    generateShim("assess-risk", "/path/to/methods/assess-risk");

    const shimPath = join(tempHome, ".mthds", "bin", "assess-risk");
    const content = readFileSync(shimPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
  });

  it("sets executable permissions on Unix", () => {
    if (process.platform === "win32") return;

    generateShim("my-method", "/path/to/methods/my-method");

    const shimPath = join(tempHome, ".mthds", "bin", "my-method");
    const stats = statSync(shimPath);
    // Check that owner execute bit is set (0o100)
    expect(stats.mode & 0o100).toBeTruthy();
  });

  it("creates the bin directory if it does not exist", () => {
    generateShim("new-method", "/path/to/methods/new-method");

    const shimPath = join(tempHome, ".mthds", "bin", "new-method");
    const content = readFileSync(shimPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
  });

  it("overwrites existing shim on reinstall", () => {
    generateShim("my-method", "/old/path");
    generateShim("my-method", "/new/path");

    const shimPath = join(tempHome, ".mthds", "bin", "my-method");
    const content = readFileSync(shimPath, "utf-8");
    expect(content).toContain("/new/path");
    expect(content).not.toContain("/old/path");
  });
});
