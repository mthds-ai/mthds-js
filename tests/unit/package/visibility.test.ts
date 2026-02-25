import { describe, it, expect } from "vitest";
import { PackageVisibilityChecker, checkVisibility } from "../../../src/package/visibility.js";
import type { ParsedManifest } from "../../../src/package/manifest/schema.js";
import type { BundleMetadata } from "../../../src/package/bundle-metadata.js";

function makeManifest(overrides: Partial<ParsedManifest> = {}): ParsedManifest {
  return {
    address: "github.com/test/pkg",
    version: "1.0.0",
    description: "Test",
    authors: [],
    exports: {},
    ...overrides,
  };
}

describe("PackageVisibilityChecker", () => {
  it("allows everything when manifest is null", () => {
    const checker = new PackageVisibilityChecker(null, [
      {
        domain: "legal",
        mainPipe: null,
        pipeReferences: [["scoring.compute_score", "pipe ref"]],
      },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(0);
  });

  it("allows bare refs (no domain)", () => {
    const manifest = makeManifest({
      exports: { legal: { pipes: ["classify"] } },
    });
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["compute_score", "pipe ref"]] },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(0);
  });

  it("allows same-domain refs", () => {
    const manifest = makeManifest({
      exports: { legal: { pipes: ["classify"] } },
    });
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["legal.classify", "pipe ref"]] },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(0);
  });

  it("allows cross-domain refs to exported pipes", () => {
    const manifest = makeManifest({
      exports: { scoring: { pipes: ["compute_score"] } },
    });
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["scoring.compute_score", "pipe ref"]] },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(0);
  });

  it("rejects cross-domain refs to non-exported pipes", () => {
    const manifest = makeManifest({
      exports: { scoring: { pipes: ["compute_score"] } },
    });
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["scoring.private_pipe", "pipe ref"]] },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.pipeRef).toBe("scoring.private_pipe");
    expect(errors[0]!.sourceDomain).toBe("legal");
  });

  it("allows cross-domain refs to main_pipe (auto-exported)", () => {
    const manifest = makeManifest({
      exports: { scoring: { pipes: [] } },
    });
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "scoring", mainPipe: "auto_pipe", pipeReferences: [] },
      { domain: "legal", mainPipe: null, pipeReferences: [["scoring.auto_pipe", "pipe ref"]] },
    ]);
    const errors = checker.validateAllPipeReferences();
    expect(errors).toHaveLength(0);
  });

  it("rejects all cross-package references (dependencies not supported)", () => {
    const manifest = makeManifest();
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["mylib->scoring.compute", "pipe ref"]] },
    ]);
    const errors = checker.validateCrossPackageReferences();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("not supported");
  });

  it("rejects cross-package references with unknown alias", () => {
    const manifest = makeManifest();
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [["unknown->scoring.compute", "pipe ref"]] },
    ]);
    const errors = checker.validateCrossPackageReferences();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("not supported");
  });

  it("validates reserved domains", () => {
    const manifest = makeManifest();
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "native.something", mainPipe: null, pipeReferences: [] },
    ]);
    const errors = checker.validateReservedDomains();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("reserved");
  });

  it("allows non-reserved domains", () => {
    const manifest = makeManifest();
    const checker = new PackageVisibilityChecker(manifest, [
      { domain: "legal", mainPipe: null, pipeReferences: [] },
    ]);
    const errors = checker.validateReservedDomains();
    expect(errors).toHaveLength(0);
  });
});

describe("checkVisibility", () => {
  it("runs all checks and aggregates errors", () => {
    const manifest = makeManifest({
      exports: { scoring: { pipes: ["compute_score"] } },
    });
    const metadatas: BundleMetadata[] = [
      {
        domain: "native.reserved",
        mainPipe: null,
        pipeReferences: [["scoring.private_pipe", "pipe ref"]],
      },
    ];
    const errors = checkVisibility(manifest, metadatas);
    // At least reserved domain error + visibility error
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty for valid setup", () => {
    const manifest = makeManifest({
      exports: { scoring: { pipes: ["compute_score"] } },
    });
    const metadatas: BundleMetadata[] = [
      {
        domain: "legal",
        mainPipe: null,
        pipeReferences: [["scoring.compute_score", "pipe ref"]],
      },
    ];
    const errors = checkVisibility(manifest, metadatas);
    expect(errors).toHaveLength(0);
  });
});
