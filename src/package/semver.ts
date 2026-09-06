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
 * A constraint is therefore evaluated clause by clause rather than compiled into
 * a single `semver.Range`: `!=` has no `Range` equivalent to compile into.
 */

import semver from "semver";

export class SemVerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemVerError";
  }
}

/**
 * One AND-ed clause of a parsed constraint: an npm range, plus whether the
 * clause was written with `!=` and so must NOT match.
 */
interface ConstraintClause {
  readonly negated: boolean;
  readonly range: semver.Range;
}

/**
 * A parsed MTHDS version constraint — the AND of its clauses. Opaque: build one
 * with `parseConstraint` and evaluate it with `versionSatisfies`.
 */
export interface VersionConstraint {
  /** The constraint as written, for error messages. */
  readonly source: string;
  readonly clauses: readonly ConstraintClause[];
}

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
  const trimmed = constraintStr.trim();
  if (trimmed === "") {
    throw new SemVerError(`Invalid semver constraint: '${constraintStr}'`);
  }

  const clauses: ConstraintClause[] = [];
  for (const rawClause of trimmed.split(",")) {
    const clause = rawClause.trim();
    if (clause === "") {
      throw new SemVerError(`Invalid semver constraint: '${constraintStr}'`);
    }

    // `!=X` has no npm equivalent — strip it and negate the clause's verdict.
    // `==X` is npm's `=X`. Both are two-character prefixes, so test them before
    // the single-character `>` / `<`, which they would otherwise shadow.
    const negated = clause.startsWith("!=");
    let body = clause;
    if (negated) {
      body = clause.slice(2).trim();
    } else if (clause.startsWith("==")) {
      body = `=${clause.slice(2).trim()}`;
    }

    let range: semver.Range;
    try {
      range = new semver.Range(body);
    } catch {
      throw new SemVerError(`Invalid semver constraint: '${constraintStr}'`);
    }
    clauses.push({ negated, range });
  }

  return { source: trimmed, clauses };
}

/**
 * Check whether a version satisfies a constraint — every clause must hold, and a
 * `!=` clause holds when its range does NOT match.
 */
export function versionSatisfies(version: semver.SemVer, constraint: VersionConstraint): boolean {
  return constraint.clauses.every((clause) => {
    const matches = semver.satisfies(version, clause.range);
    return clause.negated ? !matches : matches;
  });
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
