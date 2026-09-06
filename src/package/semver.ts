/**
 * Semver parsing and MTHDS version-constraint evaluation for the package system.
 *
 * The constraint grammar is the standard's, not npm's — see
 * `mthds/docs/spec/manifest-format.md` § "Version Constraint Syntax". It differs
 * from an npm range in three ways, all of which this module handles and none of
 * which npm's `Range` accepts: `,` separates the AND-ed clauses (npm uses a
 * space), `==` is the exact-match operator (npm spells it `=`), and `!=`
 * excludes a version (npm has no negation at all). Everything else — `^`, `~`,
 * `>=`, `<=`, `>`, `<`, a bare exact version, `*`, and the partial and wildcard
 * forms `1`, `1.0`, `1.*`, `1.0.*` — npm reads natively, so each clause is
 * delegated to it once the clause has been split off and its operator
 * normalized.
 *
 * The AND-ed clauses are recombined into **one** `semver.Range` rather than
 * evaluated one range at a time, because npm's prerelease rule is a property of
 * a whole comparator set: a prerelease satisfies a range only when some
 * comparator *in that same range* names its `major.minor.patch`. Splitting
 * `">=1.0.0-beta.1, <2.0.0"` into two ranges gives the upper bound its own
 * eligibility check, which then rejects `1.0.0-beta.1` — the lower bound's
 * explicit opt-in having been lost. Joining the clauses with a space (npm's own
 * AND) keeps them in one comparator set and makes the comma form agree with the
 * equivalent space form. Only `!=` stays separate: it has no `Range` to compile
 * into, so each exclusion is its own range whose verdict is inverted.
 */

import semver from "semver";

export class SemVerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemVerError";
  }
}

/**
 * A parsed MTHDS version constraint. Opaque: build one with `parseConstraint`
 * and evaluate it with `versionSatisfies`.
 */
export interface VersionConstraint {
  /** Every non-`!=` clause, as one comparator set. `null` when the constraint is exclusions only. */
  readonly included: semver.Range | null;
  /** One range per `!=` clause; a version matching any of them is excluded. */
  readonly excluded: readonly semver.Range[];
}

/**
 * Bounds on a constraint string. A manifest is fetched from an arbitrary
 * repository, so its `mthds_version` is untrusted input, and every clause
 * retains a compiled `semver.Range`: without a ceiling a small download
 * amplifies into hundreds of megabytes of heap and takes the process down
 * instead of producing a skipped-method error. A constraint the specification
 * can express is far below both limits.
 */
const MAX_CONSTRAINT_LENGTH = 256;
const MAX_CONSTRAINT_CLAUSES = 16;

/**
 * Parse a version string into a semver SemVer object.
 * Strips a leading 'v' prefix if present (common in git tags like v1.2.3).
 */
export function parseVersion(versionStr: string): semver.SemVer {
  const cleaned = versionStr.startsWith("v") ? versionStr.slice(1) : versionStr;
  const parsed = semver.parse(cleaned);
  if (parsed === null) {
    throw new SemVerError(`Invalid semver version: '${versionStr}'`);
  }
  return parsed;
}

/**
 * Parse an MTHDS version constraint.
 *
 * Supports the full grammar: `"^1.0.0"`, `"~1.0.0"`, `">=1.0.0, <2.0.0"`,
 * `"==1.0.0"`, `"!=1.0.0"`, `"*"`, `"1.*"`, `"1.0"`.
 */
export function parseConstraint(constraintStr: string): VersionConstraint {
  const invalid = (): never => {
    throw new SemVerError(`Invalid semver constraint: '${constraintStr}'`);
  };

  const trimmed = constraintStr.trim();
  if (trimmed === "" || trimmed.length > MAX_CONSTRAINT_LENGTH) {
    invalid();
  }

  const rawClauses = trimmed.split(",");
  if (rawClauses.length > MAX_CONSTRAINT_CLAUSES) {
    invalid();
  }

  const included: string[] = [];
  const excluded: semver.Range[] = [];

  for (const rawClause of rawClauses) {
    const clause = rawClause.trim();
    if (clause === "") {
      invalid();
    }

    // `!=X` has no npm equivalent — hold it aside and invert its verdict. `==X`
    // is npm's `=X`. Both are two-character prefixes, so test them before the
    // single-character `>` / `<`, which they would otherwise shadow. An
    // operator with no operand is rejected rather than left to npm, which reads
    // the empty body as `*` and would turn `"!="` into "matches nothing".
    if (clause.startsWith("!=")) {
      const body = clause.slice(2).trim();
      if (body === "") {
        invalid();
      }
      try {
        excluded.push(new semver.Range(body));
      } catch {
        invalid();
      }
    } else if (clause.startsWith("==")) {
      const body = clause.slice(2).trim();
      if (body === "") {
        invalid();
      }
      included.push(`=${body}`);
    } else {
      included.push(clause);
    }
  }

  // One comparator set for every included clause — see the module comment on why
  // this cannot be one range per clause.
  let range: semver.Range | null = null;
  if (included.length > 0) {
    try {
      range = new semver.Range(included.join(" "));
    } catch {
      invalid();
    }
  }

  return { included: range, excluded };
}

/**
 * Check whether a version satisfies a constraint: it must match the included
 * comparator set (if the constraint has one) and none of the `!=` exclusions.
 */
export function versionSatisfies(version: semver.SemVer, constraint: VersionConstraint): boolean {
  if (constraint.included !== null && !semver.satisfies(version, constraint.included)) {
    return false;
  }
  return !constraint.excluded.some((range) => semver.satisfies(version, range));
}

/**
 * Select the minimum version that satisfies a constraint (MVS).
 * Sorts versions ascending and returns the first match.
 */
export function selectMinimumVersion(
  availableVersions: semver.SemVer[],
  constraint: VersionConstraint,
): semver.SemVer | null {
  const sorted = [...availableVersions].sort(semver.compare);
  for (const version of sorted) {
    if (versionSatisfies(version, constraint)) {
      return version;
    }
  }
  return null;
}

/**
 * Select the minimum version that satisfies ALL constraints simultaneously.
 * Used for diamond dependency resolution.
 */
export function selectMinimumVersionForMultipleConstraints(
  availableVersions: semver.SemVer[],
  constraints: VersionConstraint[],
): semver.SemVer | null {
  const sorted = [...availableVersions].sort(semver.compare);
  for (const version of sorted) {
    if (constraints.every((constraint) => versionSatisfies(version, constraint))) {
      return version;
    }
  }
  return null;
}

/**
 * Parse a git tag into a SemVer, returning null if not a valid semver tag.
 * Handles tags like "v1.2.3" and "1.2.3", gracefully ignores non-semver tags.
 */
export function parseVersionTag(tag: string): semver.SemVer | null {
  try {
    return parseVersion(tag);
  } catch {
    return null;
  }
}
