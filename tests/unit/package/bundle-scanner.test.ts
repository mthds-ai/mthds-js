import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scanBundlesForDomainInfo,
  buildDomainExportsFromScan,
} from "../../../src/package/bundle-scanner.js";

describe("bundle-scanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mthds-scanner-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("scanBundlesForDomainInfo", () => {
    it("extracts domain and pipe codes from bundle files", () => {
      const file = join(tempDir, "legal.mthds");
      writeFileSync(
        file,
        `domain = "legal"\n\n[pipe.classify_document]\ntype = "gen"\n\n[pipe.extract_clause]\ntype = "gen"\n`,
      );

      const { domainPipes, errors } = scanBundlesForDomainInfo([file]);
      expect(errors).toHaveLength(0);
      expect(domainPipes.get("legal")).toEqual(new Set(["classify_document", "extract_clause"]));
    });

    it("collects main_pipe from bundle", () => {
      const file = join(tempDir, "scoring.mthds");
      writeFileSync(file, `domain = "scoring"\nmain_pipe = "compute_score"\n\n[pipe.compute_score]\ntype = "gen"\n`);

      const { domainMainPipes, errors } = scanBundlesForDomainInfo([file]);
      expect(errors).toHaveLength(0);
      expect(domainMainPipes.get("scoring")).toBe("compute_score");
    });

    it("merges pipes from multiple files in the same domain", () => {
      const file1 = join(tempDir, "a.mthds");
      const file2 = join(tempDir, "b.mthds");
      writeFileSync(file1, `domain = "legal"\n\n[pipe.classify]\ntype = "gen"\n`);
      writeFileSync(file2, `domain = "legal"\n\n[pipe.extract]\ntype = "gen"\n`);

      const { domainPipes } = scanBundlesForDomainInfo([file1, file2]);
      expect(domainPipes.get("legal")).toEqual(new Set(["classify", "extract"]));
    });

    it("reports errors for files without domain field", () => {
      const file = join(tempDir, "bad.mthds");
      writeFileSync(file, `[pipe.something]\ntype = "gen"\n`);

      const { errors } = scanBundlesForDomainInfo([file]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("missing or invalid 'domain'");
    });

    it("reports errors for unparseable TOML", () => {
      const file = join(tempDir, "broken.mthds");
      writeFileSync(file, "this is [[ not valid TOML");

      const { errors } = scanBundlesForDomainInfo([file]);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("buildDomainExportsFromScan", () => {
    it("builds sorted exports from scan results", () => {
      const domainPipes = new Map<string, Set<string>>([
        ["scoring", new Set(["compute_score", "normalize"])],
        ["legal", new Set(["classify"])],
      ]);
      const domainMainPipes = new Map<string, string>();

      const exports = buildDomainExportsFromScan(domainPipes, domainMainPipes);
      expect(Object.keys(exports)).toEqual(["legal", "scoring"]);
      expect(exports["legal"]!.pipes).toEqual(["classify"]);
      expect(exports["scoring"]!.pipes).toEqual(["compute_score", "normalize"]);
    });

    it("includes main_pipe in exported pipes", () => {
      const domainPipes = new Map<string, Set<string>>([
        ["scoring", new Set(["normalize"])],
      ]);
      const domainMainPipes = new Map<string, string>([
        ["scoring", "compute_score"],
      ]);

      const exports = buildDomainExportsFromScan(domainPipes, domainMainPipes);
      expect(exports["scoring"]!.pipes).toContain("compute_score");
      expect(exports["scoring"]!.pipes).toContain("normalize");
    });
  });
});
