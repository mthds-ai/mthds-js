/**
 * mthds-agent bootstrap -- first-run environment setup.
 *
 * Installs uv (if missing), then installs all required Python binaries
 * (plxt, pipelex-agent) so the environment is ready before the first
 * skill invocation. Designed to be called from the copy-paste install
 * instructions right after `npm install -g mthds`.
 *
 * Stdout protocol (plain text, same style as upgrade):
 *   - BOOTSTRAP_NOT_NEEDED          -- all binaries already ok
 *   - BOOTSTRAP_COMPLETE <json>     -- all targets installed
 *   - BOOTSTRAP_PARTIAL <json>      -- some targets installed, some failed
 *   - BOOTSTRAP_FAILED <json>       -- all targets failed
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUvInstalled, installUv, uvToolInstallSync } from "../../installer/runtime/installer.js";
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

interface BootstrapTarget {
  binaryKey: string;
  recovery: BinaryRecoveryInfo;
  oldVersion: string | null;
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Main ───────────────────────────────────────────────────────────

export async function agentBootstrap(): Promise<void> {
  // 1. Ensure uv is available — auto-install if missing
  if (!isUvInstalled()) {
    try {
      installUv();
    } catch (err) {
      agentError(
        `Could not auto-install uv: ${errorMsg(err)}. Install manually: https://docs.astral.sh/uv/getting-started/installation/`,
        "InstallError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
      return;
    }

    if (!isUvInstalled()) {
      agentError(
        "uv was installed but is not reachable in PATH. Restart your shell or add ~/.local/bin to PATH.",
        "InstallError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
      return;
    }
  }

  // 2. Determine which binaries to install
  const creds = loadCredentials();
  const binaryKeys: string[] = ["plxt"];
  if (creds.runner === Runners.PIPELEX) {
    binaryKeys.push("pipelex-agent");
  }

  // 3. Collect missing/outdated targets
  const targets: BootstrapTarget[] = [];
  for (const key of binaryKeys) {
    const recovery = BINARY_RECOVERY[key];
    if (!recovery) {
      process.stderr.write(
        `Warning: no recovery info for binary "${key}" — skipping. This is a bug.\n`
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
  }

  if (targets.length === 0) {
    process.stdout.write("BOOTSTRAP_NOT_NEEDED\n");
    return;
  }

  // 4. De-duplicate by uv_package
  const seen = new Map<string, BootstrapTarget>();
  for (const t of targets) {
    if (!seen.has(t.recovery.uv_package)) {
      seen.set(t.recovery.uv_package, t);
    }
  }
  const uniqueTargets = Array.from(seen.values());

  // 5. Install each package
  const succeeded: Map<string, BootstrapTarget> = new Map();
  const failed: Map<string, string> = new Map();

  for (const target of uniqueTargets) {
    try {
      uvToolInstallSync(target.recovery.uv_package, target.recovery.version_constraint);
      succeeded.set(target.recovery.uv_package, target);
    } catch (err) {
      failed.set(target.recovery.uv_package, errorMsg(err));
    }
  }

  // 6. Post-check and build results
  const installedEntries: Record<string, string> = {};
  for (const [uvPkg, target] of succeeded) {
    let newVersion: string | null = null;
    try {
      const postCheck = checkBinaryVersion(target.recovery);
      if (postCheck.status === "ok" || postCheck.status === "unparseable") {
        newVersion = postCheck.installed_version;
      } else if (postCheck.status === "missing") {
        newVersion = null;
      } else {
        process.stderr.write(
          `Warning: ${uvPkg} was installed but version ${postCheck.installed_version} still does not meet ${postCheck.version_constraint}.\n`
        );
        newVersion = postCheck.installed_version;
      }
    } catch (err) {
      process.stderr.write(
        `Warning: post-install version check failed for ${uvPkg}: ${errorMsg(err)}.\n`
      );
      newVersion = null;
    }
    const oldV = target.oldVersion ?? "missing";
    const newV = newVersion ?? "unknown";
    installedEntries[uvPkg] = `${oldV}->${newV}`;
  }

  const failedEntries = Object.fromEntries(failed);

  // Build marker for update-check to detect recent install
  const markerData: Record<string, unknown> = {};
  for (const target of targets) {
    const markerKey = target.binaryKey.replace(/-/g, "_");
    markerData[markerKey] = target.oldVersion ?? "missing";
  }

  // 7. Emit result
  const allSucceeded = failed.size === 0;
  const allFailed = succeeded.size === 0;

  if (allSucceeded) {
    try {
      ensureStateDir();
      writeFileSync(
        join(STATE_DIR, "just-upgraded-from"),
        JSON.stringify(markerData),
        "utf-8"
      );
    } catch (err) {
      process.stderr.write(
        `Warning: could not write upgrade marker: ${errorMsg(err)}.\n`
      );
    }
    clearCache();
    clearSnooze();
    process.stdout.write(
      "BOOTSTRAP_COMPLETE " + JSON.stringify({ installed: installedEntries }) + "\n"
    );
  } else if (allFailed) {
    process.stdout.write(
      "BOOTSTRAP_FAILED " + JSON.stringify({ failed: failedEntries }) + "\n"
    );
  } else {
    process.stdout.write(
      "BOOTSTRAP_PARTIAL " +
        JSON.stringify({ installed: installedEntries, failed: failedEntries }) +
        "\n"
    );
  }
}
