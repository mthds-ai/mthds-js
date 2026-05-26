import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VersionCheckResult } from "../../../src/installer/runtime/version-check.js";
import type { CachePayload, CacheResult } from "../../../src/agent/update-cache.js";
import { BINARY_RECOVERY } from "../../../src/agent/binaries.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;
const PLXT_CONSTRAINT = BINARY_RECOVERY["plxt"].version_constraint;

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    apiUrl: "",
    apiKey: "",
    telemetry: true,
    autoUpgrade: false,
    updateCheck: true,
  })),
}));

vi.mock("../../../src/installer/runtime/version-check.js", () => ({
  checkBinaryVersion: vi.fn(),
}));

vi.mock("../../../src/agent/update-cache.js", () => ({
  readCache: vi.fn((): CacheResult | null => null),
  writeCache: vi.fn(),
  clearCache: vi.fn(),
  computeAggregate: vi.fn((): string => "UP_TO_DATE"),
  readAndClearUpgradeMarker: vi.fn((): Record<string, unknown> | null => null),
  // Default remote cache: no entry → triggers a probe via mocked fetch
  // functions below; the probe returns null/null and is absorbed silently.
  readRemoteCache: vi.fn(() => null),
  readRemoteCacheRaw: vi.fn(() => null),
  writeRemoteCache: vi.fn(),
  clearRemoteCache: vi.fn(),
}));

vi.mock("../../../src/agent/remote-version.js", () => ({
  // Default: both probes return null (offline / no-network env). Tests that
  // need to overlay an upstream-newer version re-mock these.
  fetchLatestMthdsAgentNpm: vi.fn(async () => null),
  fetchLatestPluginMarketplace: vi.fn(async () => null),
}));

vi.mock("../../../src/agent/snooze.js", () => ({
  isSnoozed: vi.fn((): boolean => false),
  writeSnooze: vi.fn(),
  clearSnooze: vi.fn(),
  computeVersionKey: vi.fn((): string => "ok:ok:ok"),
}));

vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn(),
  agentError: vi.fn(),
  AGENT_ERROR_DOMAINS: {},
}));

vi.mock("../../../src/agent/plugin-version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/agent/plugin-version.js")>();
  return {
    ...actual,
    // Default: pretend we're in Claude Code so the plugin check is reached.
    // Tests that need the "no host" path can re-mock this.
    detectHost: vi.fn((): "claude" | "codex" | null => "claude"),
    checkPluginVersion: vi.fn((): import("../../../src/agent/update-cache.js").BinaryCheckEntry | null => null),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────

import { agentUpdateCheck } from "../../../src/agent/commands/update-check.js";
import { loadConfig } from "../../../src/config/config.js";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
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
} from "../../../src/agent/update-cache.js";
import type { RemoteCachePayload } from "../../../src/agent/update-cache.js";
import { isSnoozed, writeSnooze, clearSnooze, computeVersionKey } from "../../../src/agent/snooze.js";
import { agentSuccess } from "../../../src/agent/output.js";
import { checkPluginVersion, MIN_PLUGIN_VERSION } from "../../../src/agent/plugin-version.js";
import {
  fetchLatestMthdsAgentNpm,
  fetchLatestPluginMarketplace,
} from "../../../src/agent/remote-version.js";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PKG_VERSION = (require("../../../package.json") as { version: string }).version;

let stdoutOutput: string;

describe("update-check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    stdoutOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutOutput += String(chunk);
      return true;
    });

    // Reset defaults
    vi.mocked(loadConfig).mockReturnValue({
      runner: "api" as const,
      apiUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    vi.mocked(isSnoozed).mockReturnValue(false);
    // Default: upgrade marker absent
    vi.mocked(readAndClearUpgradeMarker).mockReturnValue(null);
  });

  // ---------------------------------------------------------------------------
  // Config disabled
  // ---------------------------------------------------------------------------
  it("emits explicit disabled signal when updateCheck config is false", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "api" as const,
      apiUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: false,
    });

    await agentUpdateCheck({});
    // Must not be empty — empty stdout now means "env-check broken" per the
    // preamble's split rule. A deliberate config choice must produce a
    // recognizable UP_TO_DATE line.
    expect(stdoutOutput).toBe("UP_TO_DATE update-check=disabled\n");
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UP_TO_DATE
  // ---------------------------------------------------------------------------
  it("re-runs fresh checks on cache hit UP_TO_DATE (catches manual upgrades)", async () => {
    // The cached payload has the old plxt version (0.3.2) — simulating a
    // user who just ran `uv tool upgrade plxt` outside the upgrade-flow.
    // No JUST_UPGRADED marker was written, but the binary is now 0.4.0.
    const cachedPayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UP_TO_DATE", payload: cachedPayload });
    // Fresh binary check reflects the manual upgrade.
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.4.0",
      version_constraint: PLXT_CONSTRAINT,
    });

    await agentUpdateCheck({});
    // The emitted UP_TO_DATE line MUST reflect the fresh version (0.4.0),
    // not the stale cached version (0.3.2). This is the whole point of
    // re-running fresh checks on this branch — without it the preamble
    // would be told versions that don't exist on the host.
    expect(stdoutOutput).toContain("plxt=0.4.0");
    expect(stdoutOutput).not.toContain("plxt=0.3.2");
    // Fresh checks called (runner=api → only plxt is checked, not pipelex-agent).
    expect(checkBinaryVersion).toHaveBeenCalledTimes(1);
    // Re-cached with fresh data so the next snooze-key comparison sees current state.
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: "UP_TO_DATE" })
    );
  });

  // ---------------------------------------------------------------------------
  // Cache hit UP_TO_DATE — remote overlay still runs to catch divergence
  // ---------------------------------------------------------------------------
  it("flips cached UP_TO_DATE to UPGRADE_AVAILABLE when remote overlay disagrees", async () => {
    const cachedPayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UP_TO_DATE", payload: cachedPayload });
    // Remote cache has been refreshed (sibling --force, independent worker)
    // and now shows mthds-agent newer than what's cached locally. The fresh
    // check inside runFreshChecks applies this overlay internally.
    vi.mocked(readRemoteCache).mockReturnValue({
      mthds_agent_latest: "999.0.0",
      plugin_latest: null,
    });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(stdoutOutput).not.toMatch(/^UP_TO_DATE /m);
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: "UPGRADE_AVAILABLE" })
    );
    // Fresh check runs (binary spawn) — the cache-UP_TO_DATE branch always
    // re-verifies installed versions now, so manual upgrades aren't reported
    // with stale cached values.
    expect(checkBinaryVersion).toHaveBeenCalledTimes(1);
  });

  it("emits snoozed sentinel on cached UP_TO_DATE remote-flip when snoozed", async () => {
    const cachedPayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UP_TO_DATE", payload: cachedPayload });
    vi.mocked(readRemoteCache).mockReturnValue({
      mthds_agent_latest: "999.0.0",
      plugin_latest: null,
    });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(isSnoozed).mockReturnValue(true);

    await agentUpdateCheck({});
    // Snoozed means "user asked for quiet" — emit the sentinel so the
    // preamble's no-output WARN rule does not fire. UPGRADE_AVAILABLE is
    // suppressed, but the re-cache still happens so the next non-snoozed
    // run notices.
    expect(stdoutOutput).toBe("UP_TO_DATE update-check=snoozed\n");
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: "UPGRADE_AVAILABLE" })
    );
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE + snoozed
  // ---------------------------------------------------------------------------
  it("emits snoozed sentinel on cached UPGRADE_AVAILABLE when snoozed (no re-verify)", async () => {
    const payload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      pipelex_agent: { s: "outdated", v: "0.21.0", r: PX_CONSTRAINT },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(isSnoozed).mockReturnValue(true);

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe("UP_TO_DATE update-check=snoozed\n");
    // Snooze check happens before re-verify — no subprocess spawns
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE + re-verify still outdated
  // ---------------------------------------------------------------------------
  it("writes UPGRADE_AVAILABLE with fresh data when re-verify confirms", async () => {
    const stalePayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "outdated", v: "0.3.1", r: PLXT_CONSTRAINT },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload: stalePayload });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "outdated", installed_version: "0.3.1", version_constraint: PLXT_CONSTRAINT,
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(writeCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE but manual upgrade detected
  // ---------------------------------------------------------------------------
  it("emits UP_TO_DATE when re-verify detects manual upgrade", async () => {
    const stalePayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "outdated", v: "0.3.1", r: PLXT_CONSTRAINT },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload: stalePayload });
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok", installed_version: "0.3.2", version_constraint: PLXT_CONSTRAINT,
    });

    await agentUpdateCheck({});
    // No UPGRADE_AVAILABLE — user already upgraded; surface the explicit
    // UP_TO_DATE line so the preamble can distinguish this from a broken run.
    expect(stdoutOutput).toContain("UP_TO_DATE");
    expect(stdoutOutput).not.toContain("UPGRADE_AVAILABLE");
    expect(writeCache).toHaveBeenCalledWith(
      expect.objectContaining({ aggregate: "UP_TO_DATE" })
    );
  });

  // ---------------------------------------------------------------------------
  // Cache miss — runs fresh checks
  // ---------------------------------------------------------------------------
  it("calls checkBinaryVersion on cache miss and writes cache", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // runner=api → only plxt checked (pipelex-agent not needed)
    expect(checkBinaryVersion).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalled();
    expect(stdoutOutput).toContain("UP_TO_DATE"); // explicit success signal
  });

  // ---------------------------------------------------------------------------
  // Cache miss — one outdated
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_AVAILABLE when plxt is outdated (runner=api)", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({ status: "outdated", installed_version: "0.3.1", version_constraint: PLXT_CONSTRAINT });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(writeCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // --force
  // ---------------------------------------------------------------------------
  it("clears cache, snooze, and remote cache with --force", async () => {
    await agentUpdateCheck({ force: true });
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
    // Remote cache has its own 24h TTL — --force must drop it too, otherwise
    // a user re-running to "ask the network now" would still get cached data.
    expect(clearRemoteCache).toHaveBeenCalled();
    // runner=api → only plxt checked
    expect(checkBinaryVersion).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // --snooze
  // ---------------------------------------------------------------------------
  it("writes snooze and returns agentSuccess with --snooze", async () => {
    vi.mocked(readCache).mockReturnValue({
      aggregate: "UPGRADE_AVAILABLE",
      payload: {
        mthds_agent: { s: "ok", v: "0.2.1" },
        pipelex_agent: { s: "outdated", v: "0.21.0", r: PX_CONSTRAINT },
        plxt: { s: "ok", v: "0.3.2" },
      },
    });

    await agentUpdateCheck({ snooze: true });
    expect(writeSnooze).toHaveBeenCalled();
    expect(agentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ snoozed: true })
    );
  });

  // ---------------------------------------------------------------------------
  // just-upgraded-from marker
  // ---------------------------------------------------------------------------
  it("outputs JUST_UPGRADED when marker exists", async () => {
    vi.mocked(readAndClearUpgradeMarker).mockReturnValue({ pipelex_agent: "0.21.0" });
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("JUST_UPGRADED");
    expect(clearCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // just-upgraded-from marker + --force still clears snooze and remote cache
  // ---------------------------------------------------------------------------
  it("clears snooze and remote cache when --force is set even with marker present", async () => {
    vi.mocked(readAndClearUpgradeMarker).mockReturnValue({ pipelex_agent: "0.21.0" });
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({ force: true });
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
    expect(clearRemoteCache).toHaveBeenCalled();
    expect(stdoutOutput).toContain("JUST_UPGRADED");
  });

  // ---------------------------------------------------------------------------
  // just-upgraded-from marker + remaining outdated items
  // ---------------------------------------------------------------------------
  it("outputs both JUST_UPGRADED and UPGRADE_AVAILABLE when marker exists but items remain outdated", async () => {
    vi.mocked(readAndClearUpgradeMarker).mockReturnValue({ pipelex_agent: "0.21.0" });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkPluginVersion).mockReturnValue({
      s: "outdated", v: "0.1.0", r: MIN_PLUGIN_VERSION,
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("JUST_UPGRADED");
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(clearCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache miss with missing binary
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_AVAILABLE when a binary is missing", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({ status: "missing", installed_version: null, version_constraint: PLXT_CONSTRAINT });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
  });

  // ---------------------------------------------------------------------------
  // Error propagation (errors surface as non-zero exit for preamble detection)
  // ---------------------------------------------------------------------------
  it("propagates errors so preamble can detect MTHDS_UPDATE_CHECK_FAILED", async () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error("unexpected boom");
    });

    await expect(agentUpdateCheck({})).rejects.toThrow("unexpected boom");
    expect(stdoutOutput).toBe("");
  });

  // Marker-content edge cases (corrupt JSON, non-object) are tested in
  // update-cache.test.ts, where the parsing lives. Here the mocked
  // readAndClearUpgradeMarker returns null for any rejected content, which
  // exercises the same fall-through path as the cache-miss tests above.

  // ---------------------------------------------------------------------------
  // Runner-aware binary checks
  // ---------------------------------------------------------------------------
  it("skips pipelex-agent check when runner=api", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // runner=api (default) → only plxt checked
    expect(checkBinaryVersion).toHaveBeenCalledTimes(1);
  });

  it("checks both pipelex-agent and plxt when runner=pipelex", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "pipelex" as const,
      apiUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // runner=pipelex → both pipelex-agent and plxt checked
    expect(checkBinaryVersion).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Plugin version — outdated triggers UPGRADE_AVAILABLE
  // ---------------------------------------------------------------------------
  it("includes plugin in UPGRADE_AVAILABLE when plugin is outdated", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkPluginVersion).mockReturnValue({
      s: "outdated", v: "0.6.2", r: MIN_PLUGIN_VERSION,
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    const json = JSON.parse(stdoutOutput.replace("UPGRADE_AVAILABLE ", "").trim());
    expect(json.plugin).toEqual({ s: "outdated", v: "0.6.2", r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Plugin version — ok does not trigger UPGRADE_AVAILABLE alone
  // ---------------------------------------------------------------------------
  it("does not trigger UPGRADE_AVAILABLE when only plugin is ok", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
    vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.9.1" });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UP_TO_DATE");
    expect(stdoutOutput).toContain("plugin=0.9.1");
    expect(stdoutOutput).not.toContain("UPGRADE_AVAILABLE");
  });

  // ---------------------------------------------------------------------------
  // Plugin version — null (not in Claude Code) is silently skipped
  // ---------------------------------------------------------------------------
  it("skips plugin check when not in Claude Code", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
    vi.mocked(checkPluginVersion).mockReturnValue(null);

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UP_TO_DATE");
    expect(stdoutOutput).not.toContain("plugin="); // absent host → key omitted
    expect(writeCache).toHaveBeenCalledWith(
      expect.not.objectContaining({
        payload: expect.objectContaining({ plugin: expect.anything() }),
      })
    );
  });

  // ---------------------------------------------------------------------------
  // UP_TO_DATE format
  // ---------------------------------------------------------------------------
  describe("UP_TO_DATE emission", () => {
    it("emits in key=value form with installed versions", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        runner: "pipelex" as const,
        apiUrl: "",
        apiKey: "",
        telemetry: true,
        autoUpgrade: false,
        updateCheck: true,
      });
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
      vi.mocked(checkBinaryVersion).mockReturnValue({
        status: "ok",
        installed_version: "0.4.0",
        version_constraint: PLXT_CONSTRAINT,
      });
      vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.11.3" });

      await agentUpdateCheck({});
      // Format: UP_TO_DATE <space-separated key=value pairs>\n
      expect(stdoutOutput).toMatch(/^UP_TO_DATE /);
      expect(stdoutOutput).toContain(`mthds-agent=${PKG_VERSION}`);
      expect(stdoutOutput).toContain("plxt=0.4.0");
      expect(stdoutOutput).toContain("pipelex-agent=0.4.0");
      expect(stdoutOutput).toContain("plugin=0.11.3");
      expect(stdoutOutput.endsWith("\n")).toBe(true);
    });

    it("emits snoozed sentinel (not UP_TO_DATE versions) on cached UPGRADE_AVAILABLE when snoozed", async () => {
      const payload: CachePayload = {
        mthds_agent: { s: "ok", v: "0.2.1" },
        plxt: { s: "outdated", v: "0.3.1", r: PLXT_CONSTRAINT },
      };
      vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload });
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
      vi.mocked(isSnoozed).mockReturnValue(true);

      await agentUpdateCheck({});
      // Snoozed: emit the sentinel (so the preamble's no-output WARN doesn't
      // fire) — but NOT the version-listing UP_TO_DATE form, because we are
      // not actually up to date.
      expect(stdoutOutput).toBe("UP_TO_DATE update-check=snoozed\n");
    });

    it("emits snoozed sentinel on fresh-check snoozed (cache miss + outdated)", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
      vi.mocked(checkBinaryVersion).mockReturnValue({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      });
      vi.mocked(isSnoozed).mockReturnValue(true);

      await agentUpdateCheck({});
      expect(stdoutOutput).toBe("UP_TO_DATE update-check=snoozed\n");
      // Cache still writes so a future non-snoozed run reads the
      // UPGRADE_AVAILABLE state.
      expect(writeCache).toHaveBeenCalledWith(
        expect.objectContaining({ aggregate: "UPGRADE_AVAILABLE" })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Remote upstream overlay
  // ---------------------------------------------------------------------------
  describe("remote upstream overlay", () => {
    it("flips mthds_agent to outdated when npm publishes a newer version", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue(null);
      vi.mocked(readRemoteCache).mockReturnValue(null);
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue("999.0.0");
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue(null);
      // Local computeAggregate would say UP_TO_DATE, but the overlay flips
      // mthds_agent → "outdated", and we depend on the real aggregate. The
      // mocked computeAggregate is a separate call we control here.
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});

      const upgradeLine = stdoutOutput
        .split("\n")
        .find((l) => l.startsWith("UPGRADE_AVAILABLE "));
      expect(upgradeLine).toBeDefined();
      const json = JSON.parse(upgradeLine!.replace("UPGRADE_AVAILABLE ", ""));
      expect(json.mthds_agent).toEqual({
        s: "outdated",
        v: PKG_VERSION,
        r: ">=999.0.0",
      });
      expect(writeRemoteCache).toHaveBeenCalled();
    });

    it("flips plugin from ok to outdated when marketplace publishes newer", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.11.1" });
      vi.mocked(readRemoteCache).mockReturnValue(null);
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue(null);
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue("0.11.3");
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});

      const upgradeLine = stdoutOutput
        .split("\n")
        .find((l) => l.startsWith("UPGRADE_AVAILABLE "));
      expect(upgradeLine).toBeDefined();
      const json = JSON.parse(upgradeLine!.replace("UPGRADE_AVAILABLE ", ""));
      expect(json.plugin).toEqual({
        s: "outdated",
        v: "0.11.1",
        r: ">=0.11.3",
      });
    });

    it("keeps the higher r when local floor and upstream both flag plugin outdated", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      // Local floor says plugin must be >= 0.11.3
      vi.mocked(checkPluginVersion).mockReturnValue({
        s: "outdated",
        v: "0.10.0",
        r: ">=0.11.3",
      });
      vi.mocked(readRemoteCache).mockReturnValue(null);
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue("0.12.5"); // upstream higher
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});

      const upgradeLine = stdoutOutput
        .split("\n")
        .find((l) => l.startsWith("UPGRADE_AVAILABLE "));
      const json = JSON.parse(upgradeLine!.replace("UPGRADE_AVAILABLE ", ""));
      // Upstream demands more than the local floor; the r reflects that.
      expect(json.plugin.r).toBe(">=0.12.5");
      expect(json.plugin.v).toBe("0.10.0");
    });

    it("keeps local floor r when it is already higher than upstream", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue({
        s: "outdated",
        v: "0.10.0",
        r: ">=0.99.0",
      });
      vi.mocked(readRemoteCache).mockReturnValue(null);
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue("0.12.5");
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});
      const upgradeLine = stdoutOutput
        .split("\n")
        .find((l) => l.startsWith("UPGRADE_AVAILABLE "));
      const json = JSON.parse(upgradeLine!.replace("UPGRADE_AVAILABLE ", ""));
      expect(json.plugin.r).toBe(">=0.99.0");
    });

    it("uses fresh remote cache when present (no fetch)", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.11.1" });
      vi.mocked(readRemoteCache).mockReturnValue({
        mthds_agent_latest: null,
        plugin_latest: "0.11.3",
      } as RemoteCachePayload);
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});

      expect(fetchLatestMthdsAgentNpm).not.toHaveBeenCalled();
      expect(fetchLatestPluginMarketplace).not.toHaveBeenCalled();
      expect(writeRemoteCache).not.toHaveBeenCalled();
      const upgradeLine = stdoutOutput
        .split("\n")
        .find((l) => l.startsWith("UPGRADE_AVAILABLE "));
      const json = JSON.parse(upgradeLine!.replace("UPGRADE_AVAILABLE ", ""));
      expect(json.plugin.r).toBe(">=0.11.3");
    });

    it("leaves payload unchanged when both probes fail and no prior cache", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.11.1" });
      vi.mocked(readRemoteCache).mockReturnValue(null);
      vi.mocked(readRemoteCacheRaw).mockReturnValue(null);
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue(null);
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

      await agentUpdateCheck({});

      expect(writeRemoteCache).not.toHaveBeenCalled(); // nothing to persist
      expect(stdoutOutput).toContain("UP_TO_DATE");
      expect(stdoutOutput).not.toContain("UPGRADE_AVAILABLE");
    });

    it("preserves prior value for the field whose probe failed this round", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(checkPluginVersion).mockReturnValue({ s: "ok", v: "0.11.1" });
      vi.mocked(readRemoteCache).mockReturnValue(null); // cache expired
      vi.mocked(readRemoteCacheRaw).mockReturnValue({
        mthds_agent_latest: "0.5.0",
        plugin_latest: "0.11.3", // last-known plugin upstream
      });
      // This round: npm probe succeeds, marketplace probe fails.
      vi.mocked(fetchLatestMthdsAgentNpm).mockResolvedValue("0.6.0");
      vi.mocked(fetchLatestPluginMarketplace).mockResolvedValue(null);
      vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");

      await agentUpdateCheck({});

      // Merged cache: fresh npm value + preserved plugin value.
      expect(writeRemoteCache).toHaveBeenCalledWith({
        mthds_agent_latest: "0.6.0",
        plugin_latest: "0.11.3",
      });
    });

    it("skips remote overlay entirely when updateCheck is disabled", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        runner: "api" as const,
        apiUrl: "",
        apiKey: "",
        telemetry: true,
        autoUpgrade: false,
        updateCheck: false,
      });

      await agentUpdateCheck({});
      expect(fetchLatestMthdsAgentNpm).not.toHaveBeenCalled();
      expect(fetchLatestPluginMarketplace).not.toHaveBeenCalled();
      expect(readRemoteCache).not.toHaveBeenCalled();
    });

    it("does not crash when the upstream layer throws", async () => {
      vi.mocked(readCache).mockReturnValue(null);
      vi.mocked(readRemoteCache).mockImplementation(() => {
        throw new Error("boom");
      });
      vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

      // The overlay catch emits a one-line warning to stderr; suppress it here
      // since it's the expected outcome of this scenario, not test noise.
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        await agentUpdateCheck({});
      } finally {
        stderrSpy.mockRestore();
      }
      expect(stdoutOutput).toContain("UP_TO_DATE");
    });
  });
});
