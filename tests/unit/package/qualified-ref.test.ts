import { describe, it, expect } from "vitest";
import {
  parseRef,
  parseConceptRef,
  parsePipeRef,
  isLocalTo,
  isExternalTo,
  isQualified,
  fullRef,
  hasCrossPackagePrefix,
  splitCrossPackageRef,
} from "../../../src/package/qualified-ref.js";
import { QualifiedRefError } from "../../../src/package/exceptions.js";

describe("parseRef", () => {
  it("parses bare ref (no domain)", () => {
    const ref = parseRef("compute_score");
    expect(ref.domainPath).toBeNull();
    expect(ref.localCode).toBe("compute_score");
  });

  it("parses qualified ref", () => {
    const ref = parseRef("scoring.compute_score");
    expect(ref.domainPath).toBe("scoring");
    expect(ref.localCode).toBe("compute_score");
  });

  it("parses deeply nested domain ref", () => {
    const ref = parseRef("legal.contracts.extract_clause");
    expect(ref.domainPath).toBe("legal.contracts");
    expect(ref.localCode).toBe("extract_clause");
  });

  it("throws QualifiedRefError for empty string", () => {
    expect(() => parseRef("")).toThrow(QualifiedRefError);
  });

  it("throws QualifiedRefError for leading dot", () => {
    expect(() => parseRef(".invalid")).toThrow(QualifiedRefError);
  });

  it("throws QualifiedRefError for trailing dot", () => {
    expect(() => parseRef("invalid.")).toThrow(QualifiedRefError);
  });

  it("throws QualifiedRefError for consecutive dots", () => {
    expect(() => parseRef("legal..contracts")).toThrow(QualifiedRefError);
  });
});

describe("parseConceptRef", () => {
  it("parses valid concept ref", () => {
    const ref = parseConceptRef("legal.contracts.NonCompeteClause");
    expect(ref.domainPath).toBe("legal.contracts");
    expect(ref.localCode).toBe("NonCompeteClause");
  });

  it("parses bare PascalCase ref", () => {
    const ref = parseConceptRef("MyContract");
    expect(ref.domainPath).toBeNull();
    expect(ref.localCode).toBe("MyContract");
  });

  it("throws for non-PascalCase local code", () => {
    expect(() => parseConceptRef("legal.snake_case")).toThrow(QualifiedRefError);
    expect(() => parseConceptRef("legal.snake_case")).toThrow(/PascalCase/);
  });

  it("throws for non-snake_case domain segment", () => {
    expect(() => parseConceptRef("CamelDomain.MyCode")).toThrow(QualifiedRefError);
    expect(() => parseConceptRef("CamelDomain.MyCode")).toThrow(/snake_case/);
  });
});

describe("parsePipeRef", () => {
  it("parses valid pipe ref", () => {
    const ref = parsePipeRef("scoring.compute_score");
    expect(ref.domainPath).toBe("scoring");
    expect(ref.localCode).toBe("compute_score");
  });

  it("parses bare snake_case ref", () => {
    const ref = parsePipeRef("compute_score");
    expect(ref.domainPath).toBeNull();
    expect(ref.localCode).toBe("compute_score");
  });

  it("throws for non-snake_case local code", () => {
    expect(() => parsePipeRef("scoring.BadName")).toThrow(QualifiedRefError);
    expect(() => parsePipeRef("scoring.BadName")).toThrow(/snake_case/);
  });

  it("throws for non-snake_case domain segment", () => {
    expect(() => parsePipeRef("BadDomain.compute_score")).toThrow(QualifiedRefError);
  });
});

describe("isQualified / fullRef", () => {
  it("returns false for bare ref", () => {
    const ref = parseRef("code");
    expect(isQualified(ref)).toBe(false);
  });

  it("returns true for qualified ref", () => {
    const ref = parseRef("domain.code");
    expect(isQualified(ref)).toBe(true);
  });

  it("fullRef reconstructs the string", () => {
    expect(fullRef(parseRef("scoring.compute_score"))).toBe("scoring.compute_score");
    expect(fullRef(parseRef("compute_score"))).toBe("compute_score");
  });
});

describe("isLocalTo / isExternalTo", () => {
  it("bare ref is local to any domain", () => {
    const ref = parseRef("compute_score");
    expect(isLocalTo(ref, "scoring")).toBe(true);
    expect(isExternalTo(ref, "scoring")).toBe(false);
  });

  it("same-domain ref is local", () => {
    const ref = parseRef("scoring.compute_score");
    expect(isLocalTo(ref, "scoring")).toBe(true);
    expect(isExternalTo(ref, "scoring")).toBe(false);
  });

  it("different-domain ref is external", () => {
    const ref = parseRef("scoring.compute_score");
    expect(isLocalTo(ref, "legal")).toBe(false);
    expect(isExternalTo(ref, "legal")).toBe(true);
  });
});

describe("hasCrossPackagePrefix / splitCrossPackageRef", () => {
  it("detects cross-package prefix", () => {
    expect(hasCrossPackagePrefix("alias->domain.pipe")).toBe(true);
    expect(hasCrossPackagePrefix("normal.pipe")).toBe(false);
  });

  it("splits cross-package ref correctly", () => {
    const [alias, remainder] = splitCrossPackageRef("mylib->scoring.compute");
    expect(alias).toBe("mylib");
    expect(remainder).toBe("scoring.compute");
  });

  it("throws for non-cross-package ref", () => {
    expect(() => splitCrossPackageRef("normal.pipe")).toThrow(QualifiedRefError);
  });
});
