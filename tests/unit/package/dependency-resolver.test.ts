import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectMthdsFiles,
  determineExportedPipes,
  resolveAllDependencies,
} from "../../../src/package/dependency-resolver.js";
import { DependencyResolveError } from "../../../src/package/exceptions.js";
import type { ParsedManifest } from "../../../src/package/manifest/schema.js";

describe("collectMthdsFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-resolver-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array for empty directory", () => {
    expect(collectMthdsFiles(tempDir)).toEqual([]);
  });

  it("collects .mthds files recursively", () => {
    writeFileSync(join(tempDir, "a.mthds"), "");
    mkdirSync(join(tempDir, "sub"));
    writeFileSync(join(tempDir, "sub", "b.mthds"), "");
    writeFileSync(join(tempDir, "not-mthds.txt"), "");

    const files = collectMthdsFiles(tempDir);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("a.mthds");
    expect(files[1]).toContain("b.mthds");
  });

  it("returns sorted paths", () => {
    writeFileSync(join(tempDir, "z.mthds"), "");
    writeFileSync(join(tempDir, "a.mthds"), "");

    const files = collectMthdsFiles(tempDir);
    expect(files[0]).toContain("a.mthds");
    expect(files[1]).toContain("z.mthds");
  });
});

describe("determineExportedPipes", () => {
  it("returns null for null manifest", () => {
    expect(determineExportedPipes(null)).toBeNull();
  });

  it("returns null for manifest without exports", () => {
    const manifest: ParsedManifest = {
      address: "github.com/test/pkg",
      version: "1.0.0",
      description: "Test",
      authors: [],
      dependencies: {},
      exports: {},
    };
    expect(determineExportedPipes(manifest)).toBeNull();
  });

  it("returns set of exported pipe codes", () => {
    const manifest: ParsedManifest = {
      address: "github.com/test/pkg",
      version: "1.0.0",
      description: "Test",
      authors: [],
      dependencies: {},
      exports: {
        legal: { pipes: ["classify", "extract"] },
        scoring: { pipes: ["compute_score"] },
      },
    };
    const exported = determineExportedPipes(manifest);
    expect(exported).toEqual(new Set(["classify", "extract", "compute_score"]));
  });
});

describe("resolveAllDependencies — local deps", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-resolve-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a local path dependency", () => {
    // Create package root with METHODS.toml
    const pkgRoot = join(tempDir, "root");
    mkdirSync(pkgRoot);
    writeFileSync(
      join(pkgRoot, "METHODS.toml"),
      `[package]\naddress = "github.com/me/pkg"\nversion = "1.0.0"\ndescription = "Root"\n`,
    );

    // Create local dep directory
    const depDir = join(tempDir, "dep");
    mkdirSync(depDir);
    writeFileSync(
      join(depDir, "METHODS.toml"),
      `[package]\naddress = "github.com/org/dep"\nversion = "1.0.0"\ndescription = "Dep"\n`,
    );
    writeFileSync(join(depDir, "bundle.mthds"), `domain = "test"\n`);

    const manifest: ParsedManifest = {
      address: "github.com/me/pkg",
      version: "1.0.0",
      description: "Root",
      authors: [],
      dependencies: {
        dep: { address: "github.com/org/dep", version: "^1.0.0", path: "../dep" },
      },
      exports: {},
    };

    return resolveAllDependencies(manifest, pkgRoot).then((resolved) => {
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.alias).toBe("dep");
      expect(resolved[0]!.address).toBe("github.com/org/dep");
      expect(resolved[0]!.manifest).not.toBeNull();
      expect(resolved[0]!.mthdsFiles.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("throws DependencyResolveError for missing local path", () => {
    const pkgRoot = join(tempDir, "root");
    mkdirSync(pkgRoot);

    const manifest: ParsedManifest = {
      address: "github.com/me/pkg",
      version: "1.0.0",
      description: "Root",
      authors: [],
      dependencies: {
        dep: { address: "github.com/org/dep", version: "^1.0.0", path: "../nonexistent" },
      },
      exports: {},
    };

    return expect(resolveAllDependencies(manifest, pkgRoot)).rejects.toThrow(
      DependencyResolveError,
    );
  });

  it("resolves dependency without manifest", () => {
    const pkgRoot = join(tempDir, "root");
    mkdirSync(pkgRoot);

    // Dep directory without METHODS.toml
    const depDir = join(tempDir, "dep");
    mkdirSync(depDir);
    writeFileSync(join(depDir, "bundle.mthds"), `domain = "test"\n`);

    const manifest: ParsedManifest = {
      address: "github.com/me/pkg",
      version: "1.0.0",
      description: "Root",
      authors: [],
      dependencies: {
        dep: { address: "github.com/org/dep", version: "^1.0.0", path: "../dep" },
      },
      exports: {},
    };

    return resolveAllDependencies(manifest, pkgRoot).then((resolved) => {
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.manifest).toBeNull();
      expect(resolved[0]!.exportedPipeCodes).toBeNull();
    });
  });

  it("returns empty array when no dependencies", () => {
    const pkgRoot = join(tempDir, "root");
    mkdirSync(pkgRoot);

    const manifest: ParsedManifest = {
      address: "github.com/me/pkg",
      version: "1.0.0",
      description: "Root",
      authors: [],
      dependencies: {},
      exports: {},
    };

    return resolveAllDependencies(manifest, pkgRoot).then((resolved) => {
      expect(resolved).toHaveLength(0);
    });
  });
});
