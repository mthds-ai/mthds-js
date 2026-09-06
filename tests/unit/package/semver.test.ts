import { describe, it, expect } from "vitest";
import {
  parseVersion,
  parseConstraint,
  versionSatisfies,
  selectMinimumVersion,
  selectMinimumVersionForMultipleConstraints,
  parseVersionTag,
  SemVerError,
} from "../../../src/package/semver.js";

describe("parseVersion", () => {
  it("parses a standard semver string", () => {
    const ver = parseVersion("1.2.3");
    expect(ver.major).toBe(1);
    expect(ver.minor).toBe(2);
    expect(ver.patch).toBe(3);
  });

  it("strips leading v prefix", () => {
    const ver = parseVersion("v2.0.0");
    expect(ver.major).toBe(2);
  });

  it("parses prerelease versions", () => {
    const ver = parseVersion("1.0.0-beta.1");
    expect(ver.prerelease).toEqual(["beta", 1]);
  });

  it("throws SemVerError for invalid version", () => {
    expect(() => parseVersion("not-a-version")).toThrow(SemVerError);
  });

  it("throws SemVerError for empty string", () => {
    expect(() => parseVersion("")).toThrow(SemVerError);
  });
});

describe("parseConstraint", () => {
  it("parses caret constraint", () => {
    const range = parseConstraint("^1.0.0");
    expect(range).toBeDefined();
  });

  it("parses tilde constraint", () => {
    const range = parseConstraint("~1.0.0");
    expect(range).toBeDefined();
  });

  it("parses range constraint", () => {
    const range = parseConstraint(">=1.0.0 <2.0.0");
    expect(range).toBeDefined();
  });

  it("parses wildcard", () => {
    const range = parseConstraint("*");
    expect(range).toBeDefined();
  });

  it("parses a comma-separated compound constraint", () => {
    expect(parseConstraint(">=1.0.0, <2.0.0")).toBeDefined();
    expect(parseConstraint(">=1.0.0,<2.0.0")).toBeDefined();
  });

  // Asserted through `versionSatisfies` rather than with `toBeDefined()`: the
  // parse result is a plain object, so a parser that produced an empty one would
  // pass a definedness check while making every version satisfy every constraint.
  it("parses the == and != operators", () => {
    expect(versionSatisfies(parseVersion("1.0.0"), parseConstraint("==1.0.0"))).toBe(true);
    expect(versionSatisfies(parseVersion("1.0.1"), parseConstraint("==1.0.0"))).toBe(false);
    expect(versionSatisfies(parseVersion("1.0.0"), parseConstraint("!=1.0.0"))).toBe(false);
    expect(versionSatisfies(parseVersion("1.0.1"), parseConstraint("!=1.0.0"))).toBe(true);
  });

  it("parses partial and wildcard forms", () => {
    expect(versionSatisfies(parseVersion("1.9.9"), parseConstraint("1"))).toBe(true);
    expect(versionSatisfies(parseVersion("2.0.0"), parseConstraint("1"))).toBe(false);
    expect(versionSatisfies(parseVersion("1.0.9"), parseConstraint("1.0"))).toBe(true);
    expect(versionSatisfies(parseVersion("1.9.0"), parseConstraint("1.*"))).toBe(true);
    expect(versionSatisfies(parseVersion("1.0.9"), parseConstraint("1.0.*"))).toBe(true);
    expect(versionSatisfies(parseVersion("1.1.0"), parseConstraint("1.0.*"))).toBe(false);
  });

  it("throws SemVerError for invalid constraint", () => {
    expect(() => parseConstraint("not-valid!!!")).toThrow(SemVerError);
  });

  it("throws SemVerError for an empty or all-empty-clause constraint", () => {
    expect(() => parseConstraint("")).toThrow(SemVerError);
    expect(() => parseConstraint("   ")).toThrow(SemVerError);
    expect(() => parseConstraint(">=1.0.0,")).toThrow(SemVerError);
    expect(() => parseConstraint(",")).toThrow(SemVerError);
  });

  // npm reads an empty range as `*`, so a bare `!=` would compile into "matches
  // nothing" rather than failing — an operator with no operand is rejected here.
  it("throws SemVerError for an operator with no operand", () => {
    expect(() => parseConstraint("!=")).toThrow(SemVerError);
    expect(() => parseConstraint("==")).toThrow(SemVerError);
    expect(() => parseConstraint(">=1.0.0, !=")).toThrow(SemVerError);
  });

  // A manifest is fetched from an arbitrary repository and every clause retains a
  // compiled range, so the constraint is bounded before it is split.
  it("throws SemVerError for an over-long or over-clausal constraint", () => {
    // Over the length ceiling on one clause; under the clause ceiling.
    expect(() => parseConstraint(`>=${"9".repeat(300)}.0.0`)).toThrow(SemVerError);
    // Over the clause ceiling; under the length ceiling.
    expect(() => parseConstraint(Array.from({ length: 20 }, () => "1.0.0").join(","))).toThrow(
      SemVerError,
    );
  });
});

// The MTHDS constraint grammar (mthds/docs/spec/manifest-format.md § "Version
// Constraint Syntax") is not npm's: `,` ANDs, `==` is exact, `!=` excludes.
// npm's own `satisfies` reads none of those three, so they are the cases worth
// pinning here.
describe("versionSatisfies — the MTHDS constraint grammar", () => {
  const check = (constraint: string, version: string): boolean =>
    versionSatisfies(parseVersion(version), parseConstraint(constraint));

  it("ANDs comma-separated clauses", () => {
    expect(check(">=1.0.0, <2.0.0", "1.5.0")).toBe(true);
    expect(check(">=1.0.0, <2.0.0", "2.0.0")).toBe(false);
    expect(check(">=1.0.0, <2.0.0", "0.9.0")).toBe(false);
    expect(check(">=1.0.0,<2.0.0", "1.5.0")).toBe(true);
  });

  it("reads == as exact match", () => {
    expect(check("==1.0.0", "1.0.0")).toBe(true);
    expect(check("==1.0.0", "1.0.1")).toBe(false);
  });

  it("reads != as exclusion", () => {
    expect(check("!=1.0.0", "2.0.0")).toBe(true);
    expect(check("!=1.0.0", "1.0.0")).toBe(false);
  });

  it("combines a floor with an exclusion", () => {
    expect(check(">=1.0.0, !=1.5.0", "1.6.0")).toBe(true);
    expect(check(">=1.0.0, !=1.5.0", "1.5.0")).toBe(false);
    expect(check(">=1.0.0, !=1.5.0", "0.9.0")).toBe(false);
  });

  it("treats a partial version as a wildcard on the missing components", () => {
    expect(check("1.0", "1.0.5")).toBe(true);
    expect(check("1.0", "1.1.0")).toBe(false);
    expect(check("1.*", "1.9.0")).toBe(true);
    expect(check("1.*", "2.0.0")).toBe(false);
    expect(check("*", "3.1.4")).toBe(true);
  });

  it("still reads a space-separated npm range as one clause", () => {
    expect(check(">=1.0.0 <2.0.0", "1.5.0")).toBe(true);
    expect(check(">=1.0.0 <2.0.0", "2.0.0")).toBe(false);
  });

  // npm admits a prerelease only when a comparator in the SAME range names its
  // major.minor.patch. Evaluating each comma-separated clause as its own range
  // loses the floor's opt-in, so the comma form has to agree with the space form
  // it is spelled differently from — this is why the clauses are recombined.
  it("keeps a prerelease floor's opt-in across the comma form", () => {
    expect(check(">=1.0.0-beta.1, <2.0.0", "1.0.0-beta.1")).toBe(true);
    expect(check(">=1.0.0-beta.1 <2.0.0", "1.0.0-beta.1")).toBe(true);
    expect(check(">=1.0.0-beta.1, <2.0.0", "1.0.0")).toBe(true);
    expect(check(">=1.0.0-beta.1, <2.0.0", "2.0.0")).toBe(false);
  });

  it("excludes prereleases from a constraint that opts into none", () => {
    expect(check(">=1.0.0, <3.0.0", "2.0.0-rc.1")).toBe(false);
    expect(check("*", "2.0.0-rc.1")).toBe(false);
  });
});

describe("versionSatisfies", () => {
  it("returns true when version matches caret constraint", () => {
    const ver = parseVersion("1.5.0");
    const constraint = parseConstraint("^1.0.0");
    expect(versionSatisfies(ver, constraint)).toBe(true);
  });

  it("returns false when version is outside caret constraint", () => {
    const ver = parseVersion("2.0.0");
    const constraint = parseConstraint("^1.0.0");
    expect(versionSatisfies(ver, constraint)).toBe(false);
  });

  it("returns true for exact match", () => {
    const ver = parseVersion("1.0.0");
    const constraint = parseConstraint("1.0.0");
    expect(versionSatisfies(ver, constraint)).toBe(true);
  });
});

describe("selectMinimumVersion", () => {
  it("selects the minimum matching version (MVS)", () => {
    const versions = [parseVersion("1.0.0"), parseVersion("1.5.0"), parseVersion("2.0.0")];
    const constraint = parseConstraint("^1.0.0");
    const selected = selectMinimumVersion(versions, constraint);
    expect(selected).not.toBeNull();
    expect(selected!.version).toBe("1.0.0");
  });

  it("skips non-matching versions", () => {
    const versions = [parseVersion("0.9.0"), parseVersion("1.5.0"), parseVersion("2.0.0")];
    const constraint = parseConstraint("^1.0.0");
    const selected = selectMinimumVersion(versions, constraint);
    expect(selected).not.toBeNull();
    expect(selected!.version).toBe("1.5.0");
  });

  it("returns null when no version matches", () => {
    const versions = [parseVersion("0.1.0"), parseVersion("0.2.0")];
    const constraint = parseConstraint("^1.0.0");
    expect(selectMinimumVersion(versions, constraint)).toBeNull();
  });

  it("returns null for empty list", () => {
    const constraint = parseConstraint("^1.0.0");
    expect(selectMinimumVersion([], constraint)).toBeNull();
  });
});

describe("selectMinimumVersionForMultipleConstraints", () => {
  it("selects version satisfying all constraints", () => {
    const versions = [parseVersion("1.0.0"), parseVersion("1.5.0"), parseVersion("2.0.0")];
    const constraints = [parseConstraint("^1.0.0"), parseConstraint(">=1.5.0")];
    const selected = selectMinimumVersionForMultipleConstraints(versions, constraints);
    expect(selected).not.toBeNull();
    expect(selected!.version).toBe("1.5.0");
  });

  it("returns null when constraints are unsatisfiable", () => {
    const versions = [parseVersion("1.0.0"), parseVersion("2.0.0")];
    const constraints = [parseConstraint("^1.0.0"), parseConstraint(">=2.0.0")];
    expect(selectMinimumVersionForMultipleConstraints(versions, constraints)).toBeNull();
  });
});

describe("parseVersionTag", () => {
  it("parses valid tag", () => {
    const ver = parseVersionTag("v1.2.3");
    expect(ver).not.toBeNull();
    expect(ver!.version).toBe("1.2.3");
  });

  it("parses tag without v prefix", () => {
    const ver = parseVersionTag("1.0.0");
    expect(ver).not.toBeNull();
  });

  it("returns null for non-semver tag", () => {
    expect(parseVersionTag("release-2024")).toBeNull();
    expect(parseVersionTag("latest")).toBeNull();
    expect(parseVersionTag("")).toBeNull();
  });
});
