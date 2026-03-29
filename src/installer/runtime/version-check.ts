/**
 * Version checking for external CLI binaries.
 *
 * Runs `<binary> --version`, extracts the semver, and compares against the
 * declared constraint from BinaryRecoveryInfo.
 *
 * NOTE: The skill preamble (skills/shared/preamble.md) implements a parallel
 * bash version comparison for mthds-agent itself (chicken-and-egg: must check
 * mthds-agent before calling it). That bash comparison is intentionally simpler
 * (major.minor.patch arithmetic only, no prerelease/build metadata). Both
 * implementations must stay in sync for the version gate to behave consistently.
 */

import { execFileSync } from "node:child_process";
import semver from "semver";
import type { BinaryRecoveryInfo } from "../../agent/binaries.js";

export type VersionStatus = "ok" | "missing" | "outdated" | "unparseable";

export interface VersionCheckResult {
  status: VersionStatus;
  /** The installed version string, or null if missing/unparseable. */
  installed_version: string | null;
  /** The constraint from BinaryRecoveryInfo. */
  version_constraint: string;
}

/**
 * Check whether a binary is installed and satisfies its version constraint.
 *
 * Returns one of four statuses:
 * - `ok`          — installed and satisfies the constraint
 * - `missing`     — binary not found in PATH
 * - `outdated`    — installed but below the required version
 * - `unparseable` — `--version` output could not be parsed (warns, doesn't block)
 */
export function checkBinaryVersion(
  recovery: BinaryRecoveryInfo
): VersionCheckResult {
  const { version_constraint } = recovery;

  // 1. Try running `<binary> --version`
  let rawOutput: string;
  try {
    rawOutput = execFileSync(recovery.binary, ["--version"], {
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch (err) {
    // ENOENT means the binary is genuinely not in PATH.
    // Any other error (EACCES, non-zero exit, crash) means the binary exists
    // but is broken — report as unparseable so callers don't blindly reinstall.
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return { status: "missing", installed_version: null, version_constraint };
    }
    return { status: "unparseable", installed_version: null, version_constraint };
  }

  // 2. Extract version via the recovery's regex
  const match = rawOutput.match(recovery.version_extract);
  if (!match?.[1]) {
    return {
      status: "unparseable",
      installed_version: null,
      version_constraint,
    };
  }

  // 3. Coerce to semver (lenient — handles "v" prefix, pre-release tags, etc.)
  const parsed = semver.coerce(match[1]);
  if (!parsed) {
    return {
      status: "unparseable",
      installed_version: match[1],
      version_constraint,
    };
  }

  // 4. Check against constraint
  if (semver.satisfies(parsed, version_constraint)) {
    return {
      status: "ok",
      installed_version: parsed.version,
      version_constraint,
    };
  }

  return {
    status: "outdated",
    installed_version: parsed.version,
    version_constraint,
  };
}
