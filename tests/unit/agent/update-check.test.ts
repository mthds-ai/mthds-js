import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VersionCheckResult } from "../../../src/installer/runtime/version-check.js";
import type { CachePayload, CacheResult } from "../../../src/agent/update-cache.js";

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
  checkBinaryVersion: vi.fn((): VersionCheckResult => ({
    status: "ok",
    installed_version: "0.22.0",
    version_constraint: ">=0.22.0",
  })),
}));

vi.mock("../../../src/agent/update-cache.js", () => ({
  STATE_DIR: "/tmp/mthds-test-state",
  readCache: vi.fn((): CacheResult | null => null),
  writeCache: vi.fn(),
  clearCache: vi.fn(),
  computeAggregate: vi.fn((): string => "UP_TO_DATE"),
  ensureStateDir: vi.fn(),
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

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: vi.fn((): string => {
      throw new Error("ENOENT: no such file"); // Default: marker file doesn't exist
    }),
    unlinkSync: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────

import { agentUpdateCheck } from "../../../src/agent/commands/update-check.js";
import { loadConfig } from "../../../src/config/config.js";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { readCache, writeCache, clearCache, computeAggregate } from "../../../src/agent/update-cache.js";
import { isSnoozed, writeSnooze, clearSnooze, computeVersionKey } from "../../../src/agent/snooze.js";
import { agentSuccess } from "../../../src/agent/output.js";
import { readFileSync, unlinkSync } from "node:fs";

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
      version_constraint: ">=0.22.0",
    });
    vi.mocked(isSnoozed).mockReturnValue(false);
    // Default: upgrade marker file doesn't exist
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
  });

  // ---------------------------------------------------------------------------
  // Config disabled
  // ---------------------------------------------------------------------------
  it("exits with no output when updateCheck config is false", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "api" as const,
      apiUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: false,
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe("");
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UP_TO_DATE
  // ---------------------------------------------------------------------------
  it("returns no output on cache hit UP_TO_DATE", async () => {
    const payload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      pipelex_agent: { s: "ok", v: "0.22.0" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UP_TO_DATE", payload });

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe("");
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE + snoozed
  // ---------------------------------------------------------------------------
  it("returns no output when re-verify still UPGRADE_AVAILABLE but snoozed", async () => {
    const payload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      pipelex_agent: { s: "outdated", v: "0.21.0", r: ">=0.22.0" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(isSnoozed).mockReturnValue(true);

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe("");
    // Snooze check happens before re-verify — no subprocess spawns
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE + re-verify still outdated
  // ---------------------------------------------------------------------------
  it("writes UPGRADE_AVAILABLE with fresh data when re-verify confirms", async () => {
    const stalePayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "outdated", v: "0.3.1", r: ">=0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload: stalePayload });
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "outdated", installed_version: "0.3.1", version_constraint: ">=0.3.2",
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(writeCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE but manual upgrade detected
  // ---------------------------------------------------------------------------
  it("returns silently when re-verify detects manual upgrade", async () => {
    const stalePayload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      plxt: { s: "outdated", v: "0.3.1", r: ">=0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload: stalePayload });
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok", installed_version: "0.3.2", version_constraint: ">=0.3.2",
    });

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe(""); // no UPGRADE_AVAILABLE — user already upgraded
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
    expect(stdoutOutput).toBe(""); // UP_TO_DATE = no output
  });

  // ---------------------------------------------------------------------------
  // Cache miss — one outdated
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_AVAILABLE when plxt is outdated (runner=api)", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({ status: "outdated", installed_version: "0.3.1", version_constraint: ">=0.3.2" });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(writeCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // --force
  // ---------------------------------------------------------------------------
  it("clears cache and snooze with --force", async () => {
    await agentUpdateCheck({ force: true });
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
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
        pipelex_agent: { s: "outdated", v: "0.21.0", r: ">=0.22.0" },
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
    vi.mocked(readFileSync).mockReturnValue('{"pipelex_agent":"0.21.0"}');
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("JUST_UPGRADED");
    expect(unlinkSync).toHaveBeenCalled();
    expect(clearCache).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Cache miss with missing binary
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_AVAILABLE when a binary is missing", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({ status: "missing", installed_version: null, version_constraint: ">=0.3.2" });

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

  // ---------------------------------------------------------------------------
  // Corrupt upgrade marker
  // ---------------------------------------------------------------------------
  it("handles corrupt upgrade marker (unparseable JSON) gracefully", async () => {
    vi.mocked(readFileSync).mockReturnValue("not valid json{{{");

    await agentUpdateCheck({});
    // Marker file read succeeds but JSON.parse fails → still deletes marker
    expect(unlinkSync).toHaveBeenCalled();
    // Falls through to cache miss → fresh checks
    expect(checkBinaryVersion).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Non-object upgrade marker
  // ---------------------------------------------------------------------------
  it("ignores upgrade marker that is not an object", async () => {
    vi.mocked(readFileSync).mockReturnValue('"just a string"');
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // Should not output JUST_UPGRADED — falls through to cache/fresh check
    expect(stdoutOutput).not.toContain("JUST_UPGRADED");
    expect(checkBinaryVersion).toHaveBeenCalled();
  });

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
});
