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
    expect(MTHDS_STANDARD_VERSION).toBe("9.0.0");
    expect(isValidSemver(MTHDS_STANDARD_VERSION)).toBe(true);
  });

  const CONSTRAINTS: [topic: string, constraint: string, satisfied: boolean][] = [
    ["the constraint every manifest written before the 2.0.0 cut carries", ">=1.0.0", true],
    ["an exact pin on the current standard", "9.0.0", true],
    ["the same exact pin with its operator", "==9.0.0", true],
    ["the constraint the standard's own manifest example carries", ">=9.0.0", true],
    ["a package needing the crate-key wire form", ">=2.1.0", true],
    ["a package needing the verdict natives", ">=3.0.0", true],
    ["a package needing the binding step", ">=4.0.0", true],
    ["a package needing the evidence-prompt PipeJudge", ">=5.0.0", true],
    ["a package needing plain stored names", ">=6.0.0", true],
    ["a package needing method trees", ">=7.0.0", true],
    ["a package needing problem documents coded from the core error registry", ">=8.0.0", true],
    ["a package needing problem titles written for a run's reader", ">=8.0.1", true],
    ["a package needing the categories key", ">=8.1.0", true],
    ["a package needing the spreadsheet-reading PipeStructure", ">=8.2.0", true],
    ["a caret range over the current major", "^9.0.0", true],
    ["a tilde range over the current minor", "~9.0.0", true],
    ["a wildcard over the current minor", "9.0.*", true],
    ["a wildcard over the current major", "9.*", true],
    ["any standard version at all", "*", true],
    ["a compound range, as the manifest format documents it", ">=9.0.0, <10.0.0", true],
    ["the same compound range spelled without a space", ">=9.0.0,<10.0.0", true],
    ["an exact pin on the last cut of the superseded major", "8.2.0", false],
    ["the same exact pin with its operator", "==8.2.0", false],
    ["an exact pin on an earlier minor of the superseded major", "8.1.0", false],
    ["a package capped at the superseded major's last cut", "<=8.2.0", false],
    ["a compound range closing below the current major", ">=8.0.0, <9.0.0", false],
    ["a tilde range over the superseded major's last minor", "~8.2.0", false],
    ["a wildcard over the superseded major's last minor", "8.2.*", false],
    ["a caret range over the superseded major", "^8.0.0", false],
    ["a caret range over an older major this package implemented", "^4.0.0", false],
    ["an exact pin on an older cut", "7.0.0", false],
    ["a tilde range over an older major's minor", "~7.0.0", false],
    ["a wildcard over the superseded major", "8.*", false],
    ["a package that predates the cut and says so", "<9.0.0", false],
    ["a package needing a standard that does not exist yet", ">=10.0.0", false],
    ["a compound range closing below the superseded major", ">=7.0.0, <8.0.0", false],
  ];

  for (const [topic, constraint, satisfied] of CONSTRAINTS) {
    it(`${satisfied ? "satisfies" : "does not satisfy"} ${topic}: ${constraint}`, () => {
      expect(satisfiesMthdsStandardVersion(constraint).kind).toBe(
        satisfied ? "satisfied" : "unsatisfied",
      );
    });
  }
});
