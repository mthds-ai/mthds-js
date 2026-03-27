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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { agentSuccess } from "../output.js";
import { BINARY_RECOVERY } from "../binaries.js";
import { checkBinaryVersion } from "../../installer/runtime/version-check.js";
import type { VersionCheckResult } from "../../installer/runtime/version-check.js";
import { loadCredentials } from "../../config/credentials.js";
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
  try {
    await agentUpdateCheckInner(options);
  } catch (err) {
    // Write to stderr for interactive use; preamble discards stderr via 2>/dev/null
    // but interactive `mthds-agent update-check` will show it.
    process.stderr.write(
      `update-check failed unexpectedly: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
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
    const payload = runFreshChecks();
    writeCache({ aggregate: computeAggregate(payload), payload });
    const output = { previous: upgradeMarker, current: payloadVersions(payload) };
    process.stdout.write("JUST_UPGRADED " + JSON.stringify(output) + "\n");
    return;
  }

  // 3. Handle --snooze
  if (options.snooze) {
    const payload = getOrRefreshPayload();
    const versionKey = computeVersionKey(payload);
    writeSnooze(versionKey);
    agentSuccess({ snoozed: true, version_key: versionKey });
    return;
  }

  // 4. Handle --force
  if (options.force) {
    clearCache();
    clearSnooze();
  }

  // 5. Try cache
  const cached = readCache();
  if (cached) {
    if (cached.aggregate === "UP_TO_DATE") return;
    // UPGRADE_AVAILABLE — check snooze
    const versionKey = computeVersionKey(cached.payload);
    if (isSnoozed(versionKey)) return;
    process.stdout.write(
      "UPGRADE_AVAILABLE " + JSON.stringify(cached.payload) + "\n"
    );
    return;
  }

  // 6. Cache miss — run fresh checks
  const payload = runFreshChecks();
  const aggregate = computeAggregate(payload);
  writeCache({ aggregate, payload });

  // 7. Return result
  if (aggregate === "UP_TO_DATE") return;

  const versionKey = computeVersionKey(payload);
  if (isSnoozed(versionKey)) return;
  process.stdout.write("UPGRADE_AVAILABLE " + JSON.stringify(payload) + "\n");
}

// ── Helpers ─────────────────────────────────────────────────────────

function runFreshChecks(): CachePayload {
  const pipelexRecovery = BINARY_RECOVERY["pipelex-agent"];
  const plxtRecovery = BINARY_RECOVERY["plxt"];
  if (!pipelexRecovery || !plxtRecovery) {
    throw new Error("Missing binary recovery info for pipelex-agent or plxt");
  }

  const pipelexCheck = checkBinaryVersion(pipelexRecovery);
  const plxtCheck = checkBinaryVersion(plxtRecovery);

  return {
    mthds_agent: { s: "ok", v: pkg.version },
    pipelex_agent: toBinaryEntry(pipelexCheck),
    plxt: toBinaryEntry(plxtCheck),
  };
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

function getOrRefreshPayload(): CachePayload {
  const cached = readCache();
  if (cached) return cached.payload;

  const payload = runFreshChecks();
  const aggregate = computeAggregate(payload);
  writeCache({ aggregate, payload });
  return payload;
}

function readAndClearUpgradeMarker(): Record<string, unknown> | null {
  if (!existsSync(JUST_UPGRADED_PATH)) return null;
  try {
    const content = readFileSync(JUST_UPGRADED_PATH, "utf-8");
    unlinkSync(JUST_UPGRADED_PATH);
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Corrupt marker — delete and treat as absent
    try {
      unlinkSync(JUST_UPGRADED_PATH);
    } catch {
      // ignore
    }
    return null;
  }
}

function payloadVersions(
  payload: CachePayload
): Record<string, string | null> {
  return {
    mthds_agent: payload.mthds_agent.v,
    pipelex_agent: payload.pipelex_agent.v,
    plxt: payload.plxt.v,
  };
}
