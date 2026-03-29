/**
 * mthds-agent update-check — check if binary dependencies need updating.
 *
 * Stdout protocol (consumed by skill preamble bash block):
 *   - No output         → proceed (UP_TO_DATE, disabled, or snoozed)
 *   - UPGRADE_AVAILABLE <json>  → trigger upgrade flow (read shared/upgrade-flow.md)
 *   - JUST_UPGRADED <json>      → announce what was upgraded, then continue
 *
 * The preamble captures stdout via: mthds-agent update-check 2>/dev/null || true
 * and checks for the presence of these keywords. Plain text, not agentSuccess JSON.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { agentSuccess } from "../output.js";
import { BINARY_RECOVERY } from "../binaries.js";
import { checkBinaryVersion } from "../../installer/runtime/version-check.js";
import type { VersionCheckResult } from "../../installer/runtime/version-check.js";
import { loadCredentials } from "../../config/credentials.js";
import { Runners } from "../../runners/types.js";
import {
  readCache,
  writeCache,
  clearCache,
  computeAggregate,
  STATE_DIR,
} from "../update-cache.js";
import type { CachePayload, BinaryCheckEntry } from "../update-cache.js";
import {
  isSnoozed,
  writeSnooze,
  clearSnooze,
  computeVersionKey,
} from "../snooze.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

const JUST_UPGRADED_PATH = join(STATE_DIR, "just-upgraded-from");

// ── Types ──────────────────────────────────────────────────────────

export interface UpdateCheckOptions {
  force?: boolean;
  snooze?: boolean;
}

// ── Main ───────────────────────────────────────────────────────────

export async function agentUpdateCheck(
  options: UpdateCheckOptions
): Promise<void> {
  // Let errors propagate to non-zero exit so the preamble's
  // MTHDS_UPDATE_CHECK_FAILED branch can detect real failures.
  // The preamble handles non-zero exit gracefully (warns + proceeds).
  await agentUpdateCheckInner(options);
}

async function agentUpdateCheckInner(
  options: UpdateCheckOptions
): Promise<void> {
  // 1. Check if update-check is disabled
  const creds = loadCredentials();
  if (!creds.updateCheck) return;

  // 2. Check for just-upgraded-from marker
  const upgradeMarker = readAndClearUpgradeMarker();
  if (upgradeMarker) {
    clearCache();
    const payload = runFreshChecks(creds.runner);
    writeCache({ aggregate: computeAggregate(payload), payload });
    const output = { previous: upgradeMarker, current: payloadVersions(payload) };
    process.stdout.write("JUST_UPGRADED " + JSON.stringify(output) + "\n");
    return;
  }

  // 3. Handle --force
  if (options.force) {
    clearCache();
    clearSnooze();
  }

  // 4. Handle --snooze
  if (options.snooze) {
    const payload = getOrRefreshPayload(creds.runner);
    const versionKey = computeVersionKey(payload);
    writeSnooze(versionKey);
    agentSuccess({ snoozed: true, version_key: versionKey });
    return;
  }

  // 5. Try cache
  const cached = readCache();
  if (cached) {
    if (cached.aggregate === "UP_TO_DATE") return;

    // UPGRADE_AVAILABLE — check snooze first to avoid unnecessary subprocess spawns
    const cachedKey = computeVersionKey(cached.payload);
    if (isSnoozed(cachedKey)) return;

    // Re-verify to catch manual upgrades (e.g. uv tool install --upgrade)
    const freshPayload = runFreshChecks(creds.runner);
    const freshAggregate = computeAggregate(freshPayload);
    writeCache({ aggregate: freshAggregate, payload: freshPayload });

    if (freshAggregate === "UP_TO_DATE") return;

    const freshKey = computeVersionKey(freshPayload);
    if (isSnoozed(freshKey)) return;
    process.stdout.write(
      "UPGRADE_AVAILABLE " + JSON.stringify(freshPayload) + "\n"
    );
    return;
  }

  // 6. Cache miss — run fresh checks
  const payload = runFreshChecks(creds.runner);
  const aggregate = computeAggregate(payload);

  // 7. Emit result BEFORE writing cache — if writeCache throws (e.g. state dir
  //    not creatable), the preamble still gets the signal.
  if (aggregate !== "UP_TO_DATE") {
    const versionKey = computeVersionKey(payload);
    if (!isSnoozed(versionKey)) {
      process.stdout.write(
        "UPGRADE_AVAILABLE " + JSON.stringify(payload) + "\n"
      );
    }
  }

  writeCache({ aggregate, payload });
}

// ── Helpers ─────────────────────────────────────────────────────────

function runFreshChecks(runner: string): CachePayload {
  const plxtRecovery = BINARY_RECOVERY["plxt"];
  if (!plxtRecovery) {
    throw new Error("Missing binary recovery info for plxt");
  }

  const payload: CachePayload = {
    mthds_agent: { s: "ok", v: pkg.version },
    plxt: toBinaryEntry(checkBinaryVersion(plxtRecovery)),
  };

  // Only check pipelex-agent when runner requires it
  if (runner === Runners.PIPELEX) {
    const pipelexRecovery = BINARY_RECOVERY["pipelex-agent"];
    if (!pipelexRecovery) {
      throw new Error("Missing binary recovery info for pipelex-agent");
    }
    payload.pipelex_agent = toBinaryEntry(checkBinaryVersion(pipelexRecovery));
  }

  return payload;
}

function toBinaryEntry(check: VersionCheckResult): BinaryCheckEntry {
  const entry: BinaryCheckEntry = {
    s: check.status,
    v: check.installed_version,
  };
  if (check.status !== "ok") {
    entry.r = check.version_constraint;
  }
  return entry;
}

function getOrRefreshPayload(runner: string): CachePayload {
  const cached = readCache();
  if (cached) return cached.payload;

  const payload = runFreshChecks(runner);
  const aggregate = computeAggregate(payload);
  writeCache({ aggregate, payload });
  return payload;
}

function readAndClearUpgradeMarker(): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(JUST_UPGRADED_PATH, "utf-8");
  } catch {
    return null; // File doesn't exist or unreadable
  }
  // Delete marker before parsing — even corrupt markers should be consumed
  try {
    unlinkSync(JUST_UPGRADED_PATH);
  } catch {
    // ignore
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function payloadVersions(
  payload: CachePayload
): Record<string, string | null> {
  const result: Record<string, string | null> = {
    mthds_agent: payload.mthds_agent.v,
    plxt: payload.plxt.v,
  };
  if (payload.pipelex_agent) {
    result.pipelex_agent = payload.pipelex_agent.v;
  }
  return result;
}
