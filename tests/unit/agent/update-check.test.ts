import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VersionCheckResult } from "../../../src/installer/runtime/version-check.js";
import type { CachePayload, CacheResult } from "../../../src/agent/update-cache.js";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("../../../src/config/credentials.js", () => ({
  loadCredentials: vi.fn(() => ({
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
    existsSync: vi.fn((): boolean => false),
    readFileSync: vi.fn((): string => "{}"),
    unlinkSync: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────

import { agentUpdateCheck } from "../../../src/agent/commands/update-check.js";
import { loadCredentials } from "../../../src/config/credentials.js";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { readCache, writeCache, clearCache, computeAggregate } from "../../../src/agent/update-cache.js";
import { isSnoozed, writeSnooze, clearSnooze, computeVersionKey } from "../../../src/agent/snooze.js";
import { agentSuccess } from "../../../src/agent/output.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

let stdoutOutput: string;

describe("update-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stdoutOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutOutput += String(chunk);
      return true;
    });

    // Reset defaults
    vi.mocked(loadCredentials).mockReturnValue({
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
    vi.mocked(existsSync).mockReturnValue(false);
  });

  // ---------------------------------------------------------------------------
  // Config disabled
  // ---------------------------------------------------------------------------
  it("exits with no output when updateCheck config is false", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
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
  it("returns no output when UPGRADE_AVAILABLE but snoozed", async () => {
    const payload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      pipelex_agent: { s: "outdated", v: "0.21.0", r: ">=0.22.0" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload });
    vi.mocked(isSnoozed).mockReturnValue(true);

    await agentUpdateCheck({});
    expect(stdoutOutput).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Cache hit — UPGRADE_AVAILABLE + not snoozed
  // ---------------------------------------------------------------------------
  it("writes UPGRADE_AVAILABLE to stdout when not snoozed", async () => {
    const payload: CachePayload = {
      mthds_agent: { s: "ok", v: "0.2.1" },
      pipelex_agent: { s: "outdated", v: "0.21.0", r: ">=0.22.0" },
      plxt: { s: "ok", v: "0.3.2" },
    };
    vi.mocked(readCache).mockReturnValue({ aggregate: "UPGRADE_AVAILABLE", payload });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
    expect(stdoutOutput).toContain('"pipelex_agent"');
  });

  // ---------------------------------------------------------------------------
  // Cache miss — runs fresh checks
  // ---------------------------------------------------------------------------
  it("calls checkBinaryVersion on cache miss and writes cache", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // Should check pipelex-agent and plxt (mthds-agent is self, always ok)
    expect(checkBinaryVersion).toHaveBeenCalledTimes(2);
    expect(writeCache).toHaveBeenCalled();
    expect(stdoutOutput).toBe(""); // UP_TO_DATE = no output
  });

  // ---------------------------------------------------------------------------
  // Cache miss — one outdated
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_AVAILABLE when one binary is outdated", async () => {
    vi.mocked(readCache).mockReturnValue(null);
    vi.mocked(computeAggregate).mockReturnValue("UPGRADE_AVAILABLE");
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({ status: "outdated", installed_version: "0.21.0", version_constraint: ">=0.22.0" })
      .mockReturnValueOnce({ status: "ok", installed_version: "0.3.2", version_constraint: ">=0.3.2" });

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
    expect(checkBinaryVersion).toHaveBeenCalledTimes(2);
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
    vi.mocked(existsSync).mockReturnValue(true);
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
      .mockReturnValueOnce({ status: "missing", installed_version: null, version_constraint: ">=0.22.0" })
      .mockReturnValueOnce({ status: "ok", installed_version: "0.3.2", version_constraint: ">=0.3.2" });

    await agentUpdateCheck({});
    expect(stdoutOutput).toContain("UPGRADE_AVAILABLE");
  });

  // ---------------------------------------------------------------------------
  // Error boundary
  // ---------------------------------------------------------------------------
  it("catches unexpected errors and writes to stderr without throwing", async () => {
    vi.mocked(loadCredentials).mockImplementation(() => {
      throw new Error("unexpected boom");
    });

    let stderrOutput = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput += String(chunk);
      return true;
    });

    // Should NOT throw
    await agentUpdateCheck({});
    expect(stderrOutput).toContain("update-check failed unexpectedly");
    expect(stderrOutput).toContain("unexpected boom");
    expect(stdoutOutput).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Corrupt upgrade marker
  // ---------------------------------------------------------------------------
  it("handles corrupt upgrade marker (invalid JSON) gracefully", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new SyntaxError("Unexpected token");
    });

    await agentUpdateCheck({});
    // Should delete the marker and continue (fall through to cache/fresh check path)
    expect(unlinkSync).toHaveBeenCalled();
    // Falls through to cache miss → fresh checks
    expect(checkBinaryVersion).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Non-object upgrade marker
  // ---------------------------------------------------------------------------
  it("ignores upgrade marker that is not an object", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('"just a string"');
    vi.mocked(computeAggregate).mockReturnValue("UP_TO_DATE");

    await agentUpdateCheck({});
    // Should not output JUST_UPGRADED — falls through to cache/fresh check
    expect(stdoutOutput).not.toContain("JUST_UPGRADED");
    expect(checkBinaryVersion).toHaveBeenCalled();
  });
});
