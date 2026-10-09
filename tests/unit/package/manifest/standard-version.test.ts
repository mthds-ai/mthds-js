import { describe, expect, it } from "vitest";

import {
  MTHDS_STANDARD_VERSION,
  isValidSemver,
  satisfiesMthdsStandardVersion,
} from "../../../../src/package/manifest/schema.js";

/**
 * The MTHDS standard version this package claims, pinned. Twin of `mthds-python`'s
 * `tests/unit/test_versions.py`.
 *
 * The constant is a copy of a cut made by the standard
 * (`mthds/docs/spec/versioning.md`), so a value moving here without a cut moving
 * there is exactly what the pin asserts against. Each move is also a claim that this
 * implementation obeys the standard at that version, which is why the table below
 * is rewritten with every cut: it states which manifest constraints the new number
 * satisfies and which ones it stops satisfying. The `mthds_version` tests in
 * `validate.test.ts` are written relative to the constant instead, and follow it.
 */

describe("MTHDS_STANDARD_VERSION", () => {
  it("is the standard's cut this package implements", () => {
    expect(MTHDS_STANDARD_VERSION).toBe("3.0.0");
    expect(isValidSemver(MTHDS_STANDARD_VERSION)).toBe(true);
  });

  const CONSTRAINTS: [topic: string, constraint: string, satisfied: boolean][] = [
    ["the constraint every manifest written before the 2.0.0 cut carries", ">=1.0.0", true],
    ["an exact pin on the current standard", "3.0.0", true],
    ["a package needing the crate-key wire form", ">=2.1.0", true],
    ["a package needing the verdict natives", ">=3.0.0", true],
    ["a caret range over the current major", "^3.0.0", true],
    ["a tilde range over the current minor", "~3.0.0", true],
    ["a wildcard over the current major", "3.*", true],
    ["any standard version at all", "*", true],
    ["a compound range, as the manifest format documents it", ">=3.0.0, <4.0.0", true],
    ["the same compound range spelled without a space", ">=3.0.0,<4.0.0", true],
    ["a caret range over the superseded major", "^2.0.0", false],
    ["an exact pin on a superseded cut", "2.1.1", false],
    ["a tilde range over a superseded minor", "~2.1.0", false],
    ["a wildcard over the superseded major", "2.*", false],
    ["a package that predates the cut and says so", "<3.0.0", false],
    ["a package needing a standard that does not exist yet", ">=4.0.0", false],
    ["a compound range closing below the current standard", ">=2.0.0, <3.0.0", false],
  ];

  for (const [topic, constraint, satisfied] of CONSTRAINTS) {
    it(`${satisfied ? "satisfies" : "does not satisfy"} ${topic}: ${constraint}`, () => {
      expect(satisfiesMthdsStandardVersion(constraint).kind).toBe(
        satisfied ? "satisfied" : "unsatisfied",
      );
    });
  }
});
