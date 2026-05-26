/**
 * mthds-agent update-check — check if binary dependencies need updating.
 *
 * Stdout protocol (consumed by skill preamble bash block):
 *   - UP_TO_DATE k=v ...        → explicit "all current" line; preamble proceeds
 *   - UPGRADE_AVAILABLE <json>  → trigger upgrade flow (read shared/upgrade-flow.md)
 *   - JUST_UPGRADED <json>      → announce what was upgraded, then continue
 *   - No output                 → either snoozed (caller respects silence) or
 *                                  update-check disabled via config. Anything
 *                                  else is a script bug; preamble treats it
 *                                  as a degraded env-check.
 *
 * The preamble captures stdout via: mthds-agent update-check 2>/dev/null || true
 * and checks for the presence of these keywords. Plain text, not agentSuccess JSON.
 */

import { createRequire } from "node:module";
import semver from "semver";
import { agentSuccess } from "../output.js";
import { BINARY_RECOVERY } from "../binaries.js";
import { checkBinaryVersion } from "../../installer/runtime/version-check.js";
import type { VersionCheckResult } from "../../installer/runtime/version-check.js";
import { loadConfig } from "../../config/config.js";
import { Runners } from "../../runners/types.js";
import {
  readCache,
  writeCache,
  clearCache,
  computeAggregate,
  readAndClearUpgradeMarker,
  readRemoteCache,
  readRemoteCacheRaw,
  writeRemoteCache,
  clearRemoteCache,
} from "../update-cache.js";
import type {
  CachePayload,
  BinaryCheckEntry,
  RemoteCachePayload,
} from "../update-cache.js";
import {
  isSnoozed,
  writeSnooze,
  clearSnooze,
  computeVersionKey,
} from "../snooze.js";
import { checkPluginVersion, detectHost } from "../plugin-version.js";
import {
  fetchLatestMthdsAgentNpm,
  fetchLatestPluginMarketplace,
} from "../remote-version.js";

const require = createRequire(import.meta.url);
const pkg = require("../../../package.json") as { version: string };

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
  const cfg = loadConfig();
  if (!cfg.updateCheck) {
    // Explicit signal so the preamble's "no output → WARN" rule does NOT
    // fire on every run for users who deliberately disabled update-check
    // (otherwise their config choice silently turns into a perpetual warning).
    process.stdout.write("UP_TO_DATE update-check=disabled\n");
    return;
  }

  // 2. Check for just-upgraded-from marker
  const upgradeMarker = readAndClearUpgradeMarker();
  if (upgradeMarker) {
    clearCache();
    const payload = await runFreshChecks(cfg.runner);
    const aggregate = computeAggregate(payload);
    writeCache({ aggregate, payload });
    const output = { previous: upgradeMarker, current: payloadVersions(payload) };
    process.stdout.write("JUST_UPGRADED " + JSON.stringify(output) + "\n");
    // After announcing the upgrade, also surface any remaining outdated items
    // (e.g. plugin was outdated before and is still outdated after binary upgrade).
    if (aggregate !== "UP_TO_DATE") {
      const versionKey = computeVersionKey(payload);
      if (!isSnoozed(versionKey)) {
        process.stdout.write(
          "UPGRADE_AVAILABLE " + JSON.stringify(payload) + "\n"
        );
      }
    }
    // JUST_UPGRADED carries the informational versions already — no UP_TO_DATE
    // chaser needed on this path.
    return;
  }

  // 3. Handle --force
  if (options.force) {
    clearCache();
    clearSnooze();
    // Remote cache has its own 24h TTL independent of the binary checks; a
    // user running --force expects to bypass every cache, including this one.
    clearRemoteCache();
  }

  // 4. Handle --snooze
  if (options.snooze) {
    const payload = await getOrRefreshPayload(cfg.runner);
    const versionKey = computeVersionKey(payload);
    writeSnooze(versionKey);
    agentSuccess({ snoozed: true, version_key: versionKey });
    return;
  }

  // 5. Try cache
  const cached = readCache();
  if (cached) {
    if (cached.aggregate === "UP_TO_DATE") {
      emitUpToDate(cached.payload);
      return;
    }

    // UPGRADE_AVAILABLE — check snooze first to avoid unnecessary subprocess spawns.
    // Snooze means "user explicitly asked for quiet"; respect it with no output.
    const cachedKey = computeVersionKey(cached.payload);
    if (isSnoozed(cachedKey)) return;

    // Re-verify to catch manual upgrades (e.g. uv tool install --upgrade)
    const freshPayload = await runFreshChecks(cfg.runner);
    const freshAggregate = computeAggregate(freshPayload);
    writeCache({ aggregate: freshAggregate, payload: freshPayload });

    if (freshAggregate === "UP_TO_DATE") {
      emitUpToDate(freshPayload);
      return;
    }

    const freshKey = computeVersionKey(freshPayload);
    if (isSnoozed(freshKey)) return;
    process.stdout.write(
      "UPGRADE_AVAILABLE " + JSON.stringify(freshPayload) + "\n"
    );
    return;
  }

  // 6. Cache miss — run fresh checks
  const payload = await runFreshChecks(cfg.runner);
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
    // When snoozed on a fresh outdated payload, stay silent — same rule as
    // the cached UPGRADE_AVAILABLE branch above. UP_TO_DATE is not the truth
    // here either, so don't emit it.
  } else {
    emitUpToDate(payload);
  }

  writeCache({ aggregate, payload });
}

// ── Helpers ─────────────────────────────────────────────────────────

async function runFreshChecks(runner: string): Promise<CachePayload> {
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

  // Check the host's mthds plugin version (skip when no host is detected).
  // Wrapped in try-catch so a plugin check failure never crashes update-check.
  try {
    const host = detectHost();
    if (host) {
      const pluginCheck = checkPluginVersion(host);
      if (pluginCheck) payload.plugin = pluginCheck;
    }
  } catch (err) {
    process.stderr.write(
      `Warning: plugin version check failed (${err instanceof Error ? err.message : String(err)}). Skipping plugin check.\n`
    );
  }

  // Overlay remote upstream probes (npm + GitHub marketplace.json). Same
  // try/catch isolation as the local plugin check above — a remote-layer
  // failure must never crash update-check; we degrade to local-only.
  try {
    await applyRemoteOverlay(payload);
  } catch (err) {
    process.stderr.write(
      `Warning: remote upstream check failed (${err instanceof Error ? err.message : String(err)}). Skipping upstream overlay.\n`
    );
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

async function getOrRefreshPayload(runner: string): Promise<CachePayload> {
  const cached = readCache();
  if (cached) return cached.payload;

  const payload = await runFreshChecks(runner);
  const aggregate = computeAggregate(payload);
  writeCache({ aggregate, payload });
  return payload;
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
  if (payload.plugin) {
    result.plugin = payload.plugin.v;
  }
  return result;
}

// ── UP_TO_DATE emission ─────────────────────────────────────────────

/**
 * Emit the terse UP_TO_DATE line listing the verified installed versions
 * (e.g. `UP_TO_DATE mthds-agent=0.8.1 plxt=0.4.0 plugin=0.11.3`). Replaces
 * the prior "silent success" so the preamble can distinguish a clean
 * env-check from a broken one (truly empty stdout now means a script bug).
 *
 * Optional fields (`pipelex_agent` when runner !== pipelex, `plugin` when
 * no host detected) are omitted entirely rather than written as `=null`.
 */
function emitUpToDate(payload: CachePayload): void {
  const parts: string[] = [`mthds-agent=${payload.mthds_agent.v ?? "?"}`];
  parts.push(`plxt=${payload.plxt.v ?? "?"}`);
  if (payload.pipelex_agent) {
    parts.push(`pipelex-agent=${payload.pipelex_agent.v ?? "?"}`);
  }
  if (payload.plugin) {
    parts.push(`plugin=${payload.plugin.v ?? "?"}`);
  }
  process.stdout.write("UP_TO_DATE " + parts.join(" ") + "\n");
}

// ── Remote upstream overlay ─────────────────────────────────────────

/**
 * Mutate `payload` in place to reflect upstream-newer versions. The local
 * payload's `mthds_agent` / `plugin` entries get flipped to `s: "outdated"`
 * when the installed version is older than what's published upstream — npm
 * for the agent, marketplace.json for the plugin. Each comparison is
 * gated on the corresponding remote value being a valid semver string;
 * anything else degrades silently.
 *
 * The local floor check (checkPluginVersion → MIN_PLUGIN_VERSION) runs
 * first and may already have marked plugin outdated. When both signals
 * fire, the larger of the two thresholds wins so the user-facing `r` is
 * always the more demanding requirement.
 */
async function applyRemoteOverlay(payload: CachePayload): Promise<void> {
  const remote = await getOrRefreshRemoteCache();
  if (!remote) return;

  // mthds-agent: own pkg.version vs upstream npm.
  if (remote.mthds_agent_latest) {
    const upstream = semver.coerce(remote.mthds_agent_latest);
    const own = semver.coerce(pkg.version);
    if (upstream && own && semver.gt(upstream.version, own.version)) {
      payload.mthds_agent = {
        s: "outdated",
        v: pkg.version,
        r: `>=${upstream.version}`,
      };
    }
  }

  // Plugin: only when a host was detected (payload.plugin present).
  if (payload.plugin && remote.plugin_latest) {
    const upstream = semver.coerce(remote.plugin_latest);
    if (upstream) {
      if (payload.plugin.s === "ok" && payload.plugin.v) {
        const installed = semver.coerce(payload.plugin.v);
        if (installed && semver.gt(upstream.version, installed.version)) {
          payload.plugin = {
            s: "outdated",
            v: payload.plugin.v,
            r: `>=${upstream.version}`,
          };
        }
      } else if (payload.plugin.s === "outdated" && payload.plugin.r) {
        // Floor already flagged — keep the higher of floor.r vs upstream.
        // semver.minVersion(">=0.11.3") returns "0.11.3"; bump payload.r when
        // upstream demands more.
        let floorMin: ReturnType<typeof semver.minVersion> = null;
        try {
          floorMin = semver.minVersion(payload.plugin.r);
        } catch {
          floorMin = null;
        }
        if (floorMin && semver.gt(upstream.version, floorMin.version)) {
          payload.plugin = {
            ...payload.plugin,
            r: `>=${upstream.version}`,
          };
        }
      }
    }
  }
}

/**
 * Return cached remote-version data when fresh, otherwise probe both
 * upstream sources in parallel and persist a new cache entry. Returns null
 * only when there's nothing to overlay (no fresh cache and no probe
 * succeeded — common in offline / sandboxed-no-network environments).
 *
 * Partial probe failures preserve the prior raw value for the failing
 * field, so a brief network blip doesn't blank out a previously-known
 * upstream version for up to 24h.
 */
async function getOrRefreshRemoteCache(): Promise<RemoteCachePayload | null> {
  const fresh = readRemoteCache();
  if (fresh) return fresh;

  const [npmLatest, marketLatest] = await Promise.all([
    fetchLatestMthdsAgentNpm(),
    fetchLatestPluginMarketplace(),
  ]);

  // Preserve prior values for whichever probe(s) failed this round —
  // an old upstream value is more useful than no overlay at all.
  const prior = readRemoteCacheRaw();
  const merged: RemoteCachePayload = {
    mthds_agent_latest: npmLatest ?? prior?.mthds_agent_latest ?? null,
    plugin_latest: marketLatest ?? prior?.plugin_latest ?? null,
  };

  // If we have nothing — neither a fresh probe nor a prior — skip the write
  // entirely. A null/null cache entry would just expire the same way 24h
  // later, and writing it suppresses the next attempt unnecessarily.
  if (merged.mthds_agent_latest === null && merged.plugin_latest === null) {
    return null;
  }

  // Only write when at least one probe actually succeeded this round —
  // otherwise we'd be refreshing the cache mtime with stale data and
  // delaying the next real probe by 24h.
  if (npmLatest !== null || marketLatest !== null) {
    writeRemoteCache(merged);
  }

  return merged;
}
