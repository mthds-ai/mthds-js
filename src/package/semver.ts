import semver from "semver";

export class SemVerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemVerError";
  }
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
 * Parse a constraint string into a semver Range.
 * Supports: "^1.0.0", "~1.0.0", ">=1.0.0,<2.0.0", "*", "1.*", etc.
 */
export function parseConstraint(constraintStr: string): semver.Range {
  try {
    const range = new semver.Range(constraintStr);
    return range;
  } catch {
    throw new SemVerError(`Invalid semver constraint: '${constraintStr}'`);
  }
}

/**
 * Check whether a version satisfies a constraint.
 */
export function versionSatisfies(version: semver.SemVer, constraint: semver.Range): boolean {
  return semver.satisfies(version, constraint);
}

/**
 * Select the minimum version that satisfies a constraint (MVS).
 * Sorts versions ascending and returns the first match.
 */
export function selectMinimumVersion(
  availableVersions: semver.SemVer[],
  constraint: semver.Range,
): semver.SemVer | null {
  const sorted = [...availableVersions].sort(semver.compare);
  for (const version of sorted) {
    if (semver.satisfies(version, constraint)) {
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
  constraints: semver.Range[],
): semver.SemVer | null {
  const sorted = [...availableVersions].sort(semver.compare);
  for (const version of sorted) {
    if (constraints.every((constraint) => semver.satisfies(version, constraint))) {
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
