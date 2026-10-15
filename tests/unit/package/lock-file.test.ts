import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  computePackageDigest,
  parseLockFile,
  serializeLockFile,
  generateLockFile,
  verifyLockedPackage,
} from "../../../src/package/lock-file.js";
import { LockFileError, IntegrityError } from "../../../src/package/exceptions.js";
import { MethodTreeError } from "../../../src/method-tree/index.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("lock-file", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-lock-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computePackageDigest", () => {
    it("is the tree digest of the package's method tree", async () => {
      writeFileSync(join(tempDir, "METHODS.toml"), "[package]\n");
      writeFileSync(join(tempDir, "main.mthds"), 'domain = "x"\n');
      const listing = [
        `${sha256("[package]\n")}  METHODS.toml\n`,
        `${sha256('domain = "x"\n')}  main.mthds\n`,
      ].join("");
      expect(await computePackageDigest(tempDir)).toBe(`sha256:${sha256(listing)}`);
    });

    it("changes when file content changes", async () => {
      writeFileSync(join(tempDir, "a.txt"), "v1");
      const first = await computePackageDigest(tempDir);
      writeFileSync(join(tempDir, "a.txt"), "v2");
      expect(await computePackageDigest(tempDir)).not.toBe(first);
    });

    it("leaves out what the membership rule excludes, .git included", async () => {
      writeFileSync(join(tempDir, "a.txt"), "content");
      const first = await computePackageDigest(tempDir);
      mkdirSync(join(tempDir, ".git"));
      writeFileSync(join(tempDir, ".git", "HEAD"), "ref: main");
      mkdirSync(join(tempDir, "__pycache__"));
      writeFileSync(join(tempDir, "__pycache__", "a.pyc"), "x");
      expect(await computePackageDigest(tempDir)).toBe(first);
    });

    it("roots the tree at the package directory, whatever manifest lies above it", async () => {
      writeFileSync(join(tempDir, "METHODS.toml"), "[package]\n");
      const sub = join(tempDir, "sub");
      mkdirSync(sub);
      writeFileSync(join(sub, "a.txt"), "a");
      expect(await computePackageDigest(sub)).toBe(`sha256:${sha256(`${sha256("a")}  a.txt\n`)}`);
    });

    it("raises a tree the standard refuses as a LockFileError, never a MethodTreeError", async () => {
      writeFileSync(join(tempDir, "main.mthds"), 'domain = "x"\n');
      symlinkSync("main.mthds", join(tempDir, "link.mthds"));
      const err = await computePackageDigest(tempDir).catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(LockFileError);
      expect(err).not.toBeInstanceOf(MethodTreeError);
      expect((err as Error).message).toContain("link.mthds");
    });

    it("throws LockFileError for non-existent directory", async () => {
      await expect(computePackageDigest(join(tempDir, "nonexistent"))).rejects.toThrow(
        LockFileError,
      );
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
digest = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      const lock = parseLockFile(content);
      expect(lock.packages["github.com/org/repo"]).toEqual({
        version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
        source: "https://github.com/org/repo",
      });
    });

    it("parses multiple entries", () => {
      const content = `
["github.com/org/a"]
version = "1.0.0"
digest = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/a"

["github.com/org/b"]
version = "2.0.0"
digest = "sha256:${"b".repeat(64)}"
source = "https://github.com/org/b"
`;
      const lock = parseLockFile(content);
      expect(Object.keys(lock.packages)).toHaveLength(2);
    });

    it("throws LockFileError for invalid TOML", () => {
      expect(() => parseLockFile("not [[ valid toml")).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid digest", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
digest = "md5:invalid"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });

    it("refuses a lock written before tree digests, saying how to regenerate it", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(
        /predates tree digests .*run 'lock' to regenerate it/,
      );
    });

    it("refuses an entry carrying a hash beside its digest", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
digest = "sha256:${"a".repeat(64)}"
hash = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid version", () => {
      const content = `
["github.com/org/repo"]
version = "not-semver"
digest = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      expect(() => parseLockFile(content)).toThrow(LockFileError);
    });

    it("throws LockFileError for invalid source", () => {
      const content = `
["github.com/org/repo"]
version = "1.0.0"
digest = "sha256:${"a".repeat(64)}"
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
          "github.com/org/z": {
            version: "1.0.0",
            digest: `sha256:${"a".repeat(64)}`,
            source: "https://github.com/org/z",
          },
          "github.com/org/a": {
            version: "2.0.0",
            digest: `sha256:${"b".repeat(64)}`,
            source: "https://github.com/org/a",
          },
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
digest = "sha256:${"a".repeat(64)}"
source = "https://github.com/org/repo"
`;
      const first = parseLockFile(content);
      const serialized = serializeLockFile(first);
      const second = parseLockFile(serialized);
      expect(second.packages).toEqual(first.packages);
    });
  });

  describe("generateLockFile", () => {
    it("generates lock entries for remote dependencies", async () => {
      writeFileSync(join(tempDir, "file.txt"), "content");

      const resolvedDeps = [
        {
          alias: "dep",
          address: "github.com/org/dep",
          manifest: {
            address: "github.com/org/dep",
            version: "1.0.0",
            description: "Dep",
            authors: [],
            exports: {},
          },
          packageRoot: tempDir,
        },
      ];

      const lock = await generateLockFile(resolvedDeps);
      expect(lock.packages["github.com/org/dep"]).toBeDefined();
      expect(lock.packages["github.com/org/dep"]!.version).toBe("1.0.0");
      expect(lock.packages["github.com/org/dep"]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(lock.packages["github.com/org/dep"]!.source).toBe("https://github.com/org/dep");
    });

    it("throws LockFileError for remote dep without manifest", async () => {
      const resolvedDeps = [
        {
          alias: "dep",
          address: "github.com/org/dep",
          manifest: null,
          packageRoot: tempDir,
        },
      ];

      await expect(generateLockFile(resolvedDeps)).rejects.toThrow(LockFileError);
    });
  });

  describe("verifyLockedPackage", () => {
    it("throws IntegrityError when cached package is missing", async () => {
      const locked = {
        version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
        source: "https://github.com/org/repo",
      };
      await expect(verifyLockedPackage(locked, "github.com/org/repo", tempDir)).rejects.toThrow(
        IntegrityError,
      );
    });

    it("accepts a cached package whose tree has the locked digest, and refuses one changed", async () => {
      const cached = join(tempDir, "github.com", "org", "repo", "1.0.0");
      mkdirSync(cached, { recursive: true });
      writeFileSync(join(cached, "main.mthds"), 'domain = "x"\n');
      const locked = {
        version: "1.0.0",
        digest: await computePackageDigest(cached),
        source: "https://github.com/org/repo",
      };
      await expect(
        verifyLockedPackage(locked, "github.com/org/repo", tempDir),
      ).resolves.toBeUndefined();
      writeFileSync(join(cached, "main.mthds"), 'domain = "y"\n');
      await expect(verifyLockedPackage(locked, "github.com/org/repo", tempDir)).rejects.toThrow(
        IntegrityError,
      );
    });

    it("raises a cached package whose tree the standard refuses as an IntegrityError", async () => {
      const cached = join(tempDir, "github.com", "org", "repo", "1.0.0");
      mkdirSync(cached, { recursive: true });
      writeFileSync(join(cached, "main.mthds"), 'domain = "x"\n');
      const locked = {
        version: "1.0.0",
        digest: await computePackageDigest(cached),
        source: "https://github.com/org/repo",
      };
      symlinkSync("main.mthds", join(cached, "link.mthds"));
      const err = await verifyLockedPackage(locked, "github.com/org/repo", tempDir).catch(
        (caught: unknown) => caught,
      );
      expect(err).toBeInstanceOf(IntegrityError);
      expect(err).not.toBeInstanceOf(MethodTreeError);
    });
  });
});
