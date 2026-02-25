import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeDirectoryHash,
  parseLockFile,
  serializeLockFile,
  generateLockFile,
  verifyLockedPackage,
  verifyLockFile,
  HASH_PREFIX,
  LOCK_FILENAME,
} from "../../../src/package/lock-file.js";
import { LockFileError, IntegrityError } from "../../../src/package/exceptions.js";
import type { ParsedManifest } from "../../../src/package/manifest/schema.js";

describe("lock-file", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeDirectoryHash", () => {
    it("returns sha256: prefixed hash", () => {
      writeFileSync(join(tempDir, "file.txt"), "hello");
      const hash = computeDirectoryHash(tempDir);
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("is deterministic (same content = same hash)", () => {
      writeFileSync(join(tempDir, "a.txt"), "content");
      const hash1 = computeDirectoryHash(tempDir);
      const hash2 = computeDirectoryHash(tempDir);
      expect(hash1).toBe(hash2);
    });

    it("changes when file content changes", () => {
      writeFileSync(join(tempDir, "a.txt"), "v1");
      const hash1 = computeDirectoryHash(tempDir);
      writeFileSync(join(tempDir, "a.txt"), "v2");
      const hash2 = computeDirectoryHash(tempDir);
      expect(hash1).not.toBe(hash2);
    });

    it("skips .git directory", () => {
      writeFileSync(join(tempDir, "a.txt"), "content");
      const hash1 = computeDirectoryHash(tempDir);

      mkdirSync(join(tempDir, ".git"));
      writeFileSync(join(tempDir, ".git", "HEAD"), "ref: main");
      const hash2 = computeDirectoryHash(tempDir);
      expect(hash1).toBe(hash2);
    });

    it("throws LockFileError for non-existent directory", () => {
      expect(() => computeDirectoryHash(join(tempDir, "nonexistent"))).toThrow(LockFileError);
    });

    it("handles nested directories", () => {
      mkdirSync(join(tempDir, "sub"));
      writeFileSync(join(tempDir, "sub", "nested.txt"), "deep");
      const hash = computeDirectoryHash(tempDir);
      expect(hash).toMatch(/^sha256:/);
    });
  });

  describe("parseLockFile", () => {
    it("parses empty content", () => {
      const lock = parseLockFile("");
      expect(lock.packages).toEqual({});
    });

    it("parses whitespace-only content", () => {
      const lock = parseLockFile("   \n  ");
      expect(lock.packages).toEqual({});
    });

    it("parses valid lock file", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      const lock = parseLockFile(content);
      expect(lock.packages["github.com/org/repo"]).toEqual({
        version: "1.0.0",
        hash: `sha256:${"a".repeat(64)}`,
        source: "https://github.com/org/repo",
      });
    });

    it("parses multiple entries", () => {
      const content = `
["github.com/org/a"]
version = "1.0.0"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/a"

["github.com/org/b"]
version = "2.0.0"
hash = "sha256:${"b".repeat(64)}"
source = "https://github.com/org/b"
`;
      const lock = parseLockFile(content);
      expect(Object.keys(lock.packages)).toHaveLength(2);
    });

    it("throws LockFileError for invalid TOML", () => {
      expect(() => parseLockFile("not [[ valid toml")).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid hash", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
hash = "md5:invalid"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid version", () => {
      const content = `
["github.com/org/repo"]
version = "not-semver"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid source", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
hash = "sha256:${"a".repeat(64)}"
source = "http://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });
  });

  describe("serializeLockFile", () => {
    it("serializes empty lock file", () => {
      const output = serializeLockFile({ packages: {} });
      expect(output.trim()).toBe("");
    });

    it("sorts entries by address", () => {
      const lock = {
        packages: {
          "github.com/org/z": { version: "1.0.0", hash: `sha256:${"a".repeat(64)}`, source: "https://github.com/org/z" },
          "github.com/org/a": { version: "2.0.0", hash: `sha256:${"b".repeat(64)}`, source: "https://github.com/org/a" },
        },
      };
      const output = serializeLockFile(lock);
      const aIdx = output.indexOf("github.com/org/a");
      const zIdx = output.indexOf("github.com/org/z");
      expect(aIdx).toBeLessThan(zIdx);
    });

    it("round-trips: parse -> serialize -> parse", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      const first = parseLockFile(content);
      const serialized = serializeLockFile(first);
      const second = parseLockFile(serialized);
      expect(second.packages).toEqual(first.packages);
    });
  });

  describe("generateLockFile", () => {
    it("generates lock entries for remote dependencies", () => {
      writeFileSync(join(tempDir, "file.txt"), "content");

      const manifest: ParsedManifest = {
        address: "github.com/me/pkg",
        version: "1.0.0",
        description: "Test",
        authors: [],
        dependencies: {
          dep: { address: "github.com/org/dep", version: "^1.0.0" },
        },
        exports: {},
      };

      const resolvedDeps = [{
        alias: "dep",
        address: "github.com/org/dep",
        manifest: {
          address: "github.com/org/dep",
          version: "1.0.0",
          description: "Dep",
          authors: [],
          dependencies: {},
          exports: {},
        },
        packageRoot: tempDir,
      }];

      const lock = generateLockFile(manifest, resolvedDeps);
      expect(lock.packages["github.com/org/dep"]).toBeDefined();
      expect(lock.packages["github.com/org/dep"]!.version).toBe("1.0.0");
      expect(lock.packages["github.com/org/dep"]!.hash).toMatch(/^sha256:/);
      expect(lock.packages["github.com/org/dep"]!.source).toBe("https://github.com/org/dep");
    });

    it("excludes local path dependencies", () => {
      writeFileSync(join(tempDir, "file.txt"), "content");

      const manifest: ParsedManifest = {
        address: "github.com/me/pkg",
        version: "1.0.0",
        description: "Test",
        authors: [],
        dependencies: {
          local_dep: { address: "github.com/org/local", version: "^1.0.0", path: "../local" },
        },
        exports: {},
      };

      const resolvedDeps = [{
        alias: "local_dep",
        address: "github.com/org/local",
        manifest: {
          address: "github.com/org/local",
          version: "1.0.0",
          description: "Local",
          authors: [],
          dependencies: {},
          exports: {},
        },
        packageRoot: tempDir,
      }];

      const lock = generateLockFile(manifest, resolvedDeps);
      expect(Object.keys(lock.packages)).toHaveLength(0);
    });

    it("throws LockFileError for remote dep without manifest", () => {
      const manifest: ParsedManifest = {
        address: "github.com/me/pkg",
        version: "1.0.0",
        description: "Test",
        authors: [],
        dependencies: {
          dep: { address: "github.com/org/dep", version: "^1.0.0" },
        },
        exports: {},
      };

      const resolvedDeps = [{
        alias: "dep",
        address: "github.com/org/dep",
        manifest: null,
        packageRoot: tempDir,
      }];

      expect(() => generateLockFile(manifest, resolvedDeps)).toThrow(LockFileError);
    });
  });

  describe("verifyLockedPackage", () => {
    it("throws IntegrityError when cached package is missing", () => {
      const locked = {
        version: "1.0.0",
        hash: `sha256:${"a".repeat(64)}`,
        source: "https://github.com/org/repo",
      };
      expect(() => verifyLockedPackage(locked, "github.com/org/repo", tempDir)).toThrow(
        IntegrityError,
      );
    });
  });
});
