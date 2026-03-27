/**
 * mthds-agent upgrade -- upgrade outdated/missing Python binary dependencies.
 *
 * Stdout protocol (plain text, consumed by skill upgrade-flow):
 *   - UPGRADE_NOT_NEEDED          -- all binaries ok
 *   - UPGRADE_COMPLETE <json>     -- all targets succeeded
 *   - UPGRADE_PARTIAL <json>      -- some targets succeeded, some failed
 *   - UPGRADE_FAILED <json>       -- all targets failed
 *
 * Architecture: De-duplicates by uv_package to guard against multiple binaries
 * sharing a PyPI package. Currently pipelex-agent uses "pipelex" and plxt uses
 * "pipelex-tools", so de-duplication does not trigger — but the guard prevents
 * double-installs if future binaries share a package. The binary check list
 * depends on the configured runner: always plxt; add pipelex-agent when
 * runner === "pipelex".
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { requireUv, uvToolInstallSync } from "../../installer/runtime/installer.js";
import { checkBinaryVersion } from "../../installer/runtime/version-check.js";
import type { VersionCheckResult } from "../../installer/runtime/version-check.js";
import { BINARY_RECOVERY } from "../binaries.js";
import type { BinaryRecoveryInfo } from "../binaries.js";
import { agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { clearCache, ensureStateDir, STATE_DIR } from "../update-cache.js";
import { clearSnooze } from "../snooze.js";
import { loadCredentials } from "../../config/credentials.js";
import { Runners } from "../../runners/types.js";

// ── Types ──────────────────────────────────────────────────────────

interface UpgradeTarget {
  /** Key in BINARY_RECOVERY (e.g. "plxt", "pipelex-agent") */
  binaryKey: string;
  recovery: BinaryRecoveryInfo;
  oldVersion: string | null;
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Main ───────────────────────────────────────────────────────────

export function agentUpgrade(): void {
  // requireUv() — fatal if missing
  try {
    requireUv();
  } catch (err) {
    agentError(errorMsg(err), "InstallError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
    });
    return; // unreachable — agentError calls process.exit, but explicit for TypeScript
  }

  const creds = loadCredentials();

  const binaryKeys: string[] = ["plxt"];
  if (creds.runner === Runners.PIPELEX) {
    binaryKeys.push("pipelex-agent");
  }

  // Collect outdated/missing as targets, skip unparseable
  const targets: UpgradeTarget[] = [];
  for (const key of binaryKeys) {
    const recovery = BINARY_RECOVERY[key];
    if (!recovery) {
      process.stderr.write(
        `Warning: no recovery info for binary "${key}" — skipping upgrade check. This is a bug.\n`
      );
      continue;
    }

    const check: VersionCheckResult = checkBinaryVersion(recovery);
    if (check.status === "outdated" || check.status === "missing") {
      targets.push({
        binaryKey: key,
        recovery,
        oldVersion: check.installed_version,
      });
    }
    // "ok" and "unparseable" are both skipped — unparseable means the binary
    // exists but we can't parse its version, so don't blindly reinstall.
  }

  if (targets.length === 0) {
    process.stdout.write("UPGRADE_NOT_NEEDED\n");
    return;
  }

  // De-duplicate by uv_package to avoid double-installing shared packages
  const seen = new Map<string, UpgradeTarget>();
  for (const t of targets) {
    if (!seen.has(t.recovery.uv_package)) {
      seen.set(t.recovery.uv_package, t);
    }
  }
  const uniqueTargets = Array.from(seen.values());

  // Install each unique uv_package, catching errors per-target
  const succeeded: Map<string, UpgradeTarget> = new Map();
  const failed: Map<string, string> = new Map();

  for (const target of uniqueTargets) {
    try {
      uvToolInstallSync(target.recovery.uv_package, target.recovery.version_constraint);
      succeeded.set(target.recovery.uv_package, target);
    } catch (err) {
      failed.set(target.recovery.uv_package, errorMsg(err));
    }
  }

  // Post-check successful targets to get new version
  const upgradedEntries: Record<string, string> = {};
  for (const [uvPkg, target] of succeeded) {
    let newVersion: string | null = null;
    try {
      const postCheck = checkBinaryVersion(target.recovery);
      if (postCheck.status === "ok" || postCheck.status === "unparseable") {
        newVersion = postCheck.installed_version;
      } else if (postCheck.status === "missing") {
        // PATH issue — binary was installed but not yet visible.
        // Treat as successful since uvToolInstallSync didn't throw.
        newVersion = null;
      } else {
        // "outdated" — install ran but didn't satisfy the constraint
        process.stderr.write(
          `Warning: ${uvPkg} was installed but version ${postCheck.installed_version} still does not meet ${postCheck.version_constraint}.\n`
        );
        newVersion = postCheck.installed_version;
      }
    } catch (err) {
      process.stderr.write(
        `Warning: post-upgrade version check failed for ${uvPkg}: ${errorMsg(err)}.\n`
      );
      newVersion = null;
    }
    const oldV = target.oldVersion ?? "missing";
    const newV = newVersion ?? "unknown";
    upgradedEntries[uvPkg] = `${oldV}->${newV}`;
  }

  const failedEntries = Object.fromEntries(failed);

  // Build marker with old versions keyed by binary name.
  // The update-check preamble reads and clears this marker to detect a recent upgrade.
  const markerData: Record<string, unknown> = {};
  for (const target of targets) {
    // Use binary key as marker key (e.g. "pipelex_agent", "plxt")
    const markerKey = target.binaryKey.replace(/-/g, "_");
    markerData[markerKey] = target.oldVersion ?? "missing";
  }

  // Determine outcome and emit result
  const allSucceeded = failed.size === 0;
  const allFailed = succeeded.size === 0;

  if (allSucceeded) {
    // Write marker, clear cache + snooze
    try {
      ensureStateDir();
      writeFileSync(
        join(STATE_DIR, "just-upgraded-from"),
        JSON.stringify(markerData),
        "utf-8"
      );
    } catch (err) {
      // Marker write failure should not prevent reporting success
      process.stderr.write(
        `Warning: could not write upgrade marker: ${errorMsg(err)}.\n`
      );
    }
    clearCache();
    clearSnooze();
    process.stdout.write(
      "UPGRADE_COMPLETE " + JSON.stringify({ upgraded: upgradedEntries }) + "\n"
    );
  } else if (allFailed) {
    // Do NOT clear cache/snooze, do NOT write marker
    process.stdout.write(
      "UPGRADE_FAILED " + JSON.stringify({ failed: failedEntries }) + "\n"
    );
  } else {
    // Partial — do NOT clear cache/snooze, do NOT write marker
    process.stdout.write(
      "UPGRADE_PARTIAL " +
        JSON.stringify({ upgraded: upgradedEntries, failed: failedEntries }) +
        "\n"
    );
  }
}
