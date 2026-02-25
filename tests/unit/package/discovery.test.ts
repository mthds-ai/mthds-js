import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageManifest, MANIFEST_FILENAME } from "../../../src/package/discovery.js";

const MINIMAL_MANIFEST = `
[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Test package."
`;

describe("findPackageManifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-discovery-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds METHODS.toml in the same directory", () => {
    writeFileSync(join(tempDir, MANIFEST_FILENAME), MINIMAL_MANIFEST);
    const bundlePath = join(tempDir, "bundle.mthds");
    writeFileSync(bundlePath, "");

    const manifest = findPackageManifest(bundlePath);
    expect(manifest).not.toBeNull();
    expect(manifest!.address).toBe("github.com/acme/tools");
  });

  it("finds METHODS.toml in parent directory", () => {
    writeFileSync(join(tempDir, MANIFEST_FILENAME), MINIMAL_MANIFEST);
    const subDir = join(tempDir, "sub");
    mkdirSync(subDir);
    const bundlePath = join(subDir, "bundle.mthds");
    writeFileSync(bundlePath, "");

    const manifest = findPackageManifest(bundlePath);
    expect(manifest).not.toBeNull();
    expect(manifest!.address).toBe("github.com/acme/tools");
  });

  it("stops at .git boundary", () => {
    writeFileSync(join(tempDir, MANIFEST_FILENAME), MINIMAL_MANIFEST);
    const subDir = join(tempDir, "project");
    mkdirSync(subDir);
    mkdirSync(join(subDir, ".git"));
    const deepDir = join(subDir, "src");
    mkdirSync(deepDir);
    const bundlePath = join(deepDir, "bundle.mthds");
    writeFileSync(bundlePath, "");

    const manifest = findPackageManifest(bundlePath);
    expect(manifest).toBeNull();
  });

  it("returns null when no manifest found", () => {
    const bundlePath = join(tempDir, "bundle.mthds");
    writeFileSync(bundlePath, "");
    // Create .git to stop traversal early (avoid traversing entire filesystem)
    mkdirSync(join(tempDir, ".git"));

    const manifest = findPackageManifest(bundlePath);
    expect(manifest).toBeNull();
  });
});
