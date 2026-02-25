import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCachedPackagePath,
  isCached,
  storeInCache,
  removeCachedPackage,
} from "../../../src/package/package-cache.js";
import { PackageCacheError } from "../../../src/package/exceptions.js";

describe("package-cache", () => {
  let cacheRoot: string;
  let sourceDir: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "mthds-cache-test-"));
    sourceDir = mkdtempSync(join(tmpdir(), "mthds-source-test-"));
    writeFileSync(join(sourceDir, "METHODS.toml"), "[package]\n");
    writeFileSync(join(sourceDir, "bundle.mthds"), "domain = 'test'\n");
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(sourceDir, { recursive: true, force: true });
  });

  describe("getCachedPackagePath", () => {
    it("returns correct path for address and version", () => {
      const path = getCachedPackagePath("github.com/org/repo", "1.0.0", cacheRoot);
      expect(path).toContain("github.com/org/repo");
      expect(path).toContain("1.0.0");
    });

    it("throws PackageCacheError on path traversal", () => {
      expect(() =>
        getCachedPackagePath("../../etc/passwd", "1.0.0", cacheRoot),
      ).toThrow(PackageCacheError);
    });
  });

  describe("isCached", () => {
    it("returns false when not cached", () => {
      expect(isCached("github.com/org/repo", "1.0.0", cacheRoot)).toBe(false);
    });

    it("returns false for empty directory", () => {
      const path = getCachedPackagePath("github.com/org/repo", "1.0.0", cacheRoot);
      mkdirSync(path, { recursive: true });
      expect(isCached("github.com/org/repo", "1.0.0", cacheRoot)).toBe(false);
    });

    it("returns true when cached with files", () => {
      const path = getCachedPackagePath("github.com/org/repo", "1.0.0", cacheRoot);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "file.txt"), "content");
      expect(isCached("github.com/org/repo", "1.0.0", cacheRoot)).toBe(true);
    });
  });

  describe("storeInCache", () => {
    it("copies source directory into cache", () => {
      const finalPath = storeInCache(sourceDir, "github.com/org/repo", "1.0.0", cacheRoot);
      expect(existsSync(finalPath)).toBe(true);
      expect(existsSync(join(finalPath, "METHODS.toml"))).toBe(true);
      expect(existsSync(join(finalPath, "bundle.mthds"))).toBe(true);
    });

    it("removes .git directory from cached copy", () => {
      const gitDir = join(sourceDir, ".git");
      mkdirSync(gitDir);
      writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

      const finalPath = storeInCache(sourceDir, "github.com/org/repo", "1.0.0", cacheRoot);
      expect(existsSync(join(finalPath, ".git"))).toBe(false);
    });

    it("overwrites existing cached version", () => {
      storeInCache(sourceDir, "github.com/org/repo", "1.0.0", cacheRoot);
      writeFileSync(join(sourceDir, "extra.txt"), "new file");
      const finalPath = storeInCache(sourceDir, "github.com/org/repo", "1.0.0", cacheRoot);
      expect(existsSync(join(finalPath, "extra.txt"))).toBe(true);
    });

    it("makes package retrievable via isCached", () => {
      storeInCache(sourceDir, "github.com/org/repo", "2.0.0", cacheRoot);
      expect(isCached("github.com/org/repo", "2.0.0", cacheRoot)).toBe(true);
    });
  });

  describe("removeCachedPackage", () => {
    it("returns false when package is not cached", () => {
      expect(removeCachedPackage("github.com/org/repo", "1.0.0", cacheRoot)).toBe(false);
    });

    it("removes cached package and returns true", () => {
      storeInCache(sourceDir, "github.com/org/repo", "1.0.0", cacheRoot);
      expect(isCached("github.com/org/repo", "1.0.0", cacheRoot)).toBe(true);

      expect(removeCachedPackage("github.com/org/repo", "1.0.0", cacheRoot)).toBe(true);
      expect(isCached("github.com/org/repo", "1.0.0", cacheRoot)).toBe(false);
    });
  });
});
