import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VersionCheckResult } from "../../../src/installer/runtime/version-check.js";
import { BINARY_RECOVERY } from "../../../src/agent/binaries.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;
const PLXT_CONSTRAINT = BINARY_RECOVERY["plxt"].version_constraint;

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    runnerUrl: "", platformUrl: "",
    apiKey: "",
    telemetry: true,
    autoUpgrade: false,
    updateCheck: true,
  })),
}));

vi.mock("../../../src/installer/runtime/version-check.js", () => ({
  checkBinaryVersion: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/installer.js", () => ({
  requireUv: vi.fn(() => "uv"),
  uvToolInstallSync: vi.fn(),
}));

vi.mock("../../../src/agent/update-cache.js", () => ({
  clearCache: vi.fn(),
  writeUpgradeMarker: vi.fn(),
}));

vi.mock("../../../src/agent/snooze.js", () => ({
  clearSnooze: vi.fn(),
}));

vi.mock("../../../src/agent/output.js", () => ({
  agentError: vi.fn((_msg: string, _type: string, _extras?: unknown) => {
    // Simulate process.exit(1) — the real agentError returns `never`
    throw new Error("agentError called");
  }),
  AGENT_ERROR_DOMAINS: {
    INSTALL: "install",
    BINARY: "binary",
  },
}));

// ── Imports (after mocks) ──────────────────────────────────────────

import { agentUpgrade } from "../../../src/agent/commands/upgrade.js";
import { loadConfig } from "../../../src/config/config.js";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { requireUv, uvToolInstallSync } from "../../../src/installer/runtime/installer.js";
import { clearCache, writeUpgradeMarker } from "../../../src/agent/update-cache.js";
import { clearSnooze } from "../../../src/agent/snooze.js";
import { agentError } from "../../../src/agent/output.js";

let stdoutOutput: string;

describe("agentUpgrade", () => {
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
      runnerUrl: "", platformUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });
    vi.mocked(requireUv).mockReturnValue("uv");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
  });

  // ---------------------------------------------------------------------------
  // Case 1: Upgrades outdated plxt (runner=api)
  // ---------------------------------------------------------------------------
  it("upgrades outdated plxt (runner=api)", async () => {
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      })
      // Post-check after upgrade
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      });

    await agentUpgrade();

    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", PLXT_CONSTRAINT);
    expect(writeUpgradeMarker).toHaveBeenCalled();
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 2: Upgrades both pipelex-agent and plxt (runner=pipelex)
  // ---------------------------------------------------------------------------
  it("upgrades both pipelex-agent and plxt (runner=pipelex)", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "pipelex" as const,
      runnerUrl: "", platformUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    vi.mocked(checkBinaryVersion)
      // plxt check
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      })
      // pipelex-agent check
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: PX_CONSTRAINT,
      })
      // Post-check for plxt (pipelex-tools)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      })
      // Post-check for pipelex-agent (pipelex)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: PX_CONSTRAINT,
      });

    await agentUpgrade();

    // Two different uv_packages: pipelex-tools and pipelex
    expect(uvToolInstallSync).toHaveBeenCalledTimes(2);
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", PLXT_CONSTRAINT);
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex", PX_CONSTRAINT);
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 3: De-duplicates shared uv_package
  // ---------------------------------------------------------------------------
  it("de-duplicates shared uv_package (pipelex + pipelex-agent)", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "pipelex" as const,
      runnerUrl: "", platformUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    vi.mocked(checkBinaryVersion)
      // plxt ok
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: PX_CONSTRAINT,
      })
      // Post-check for pipelex
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: PX_CONSTRAINT,
      });

    await agentUpgrade();

    // Only pipelex-agent is outdated → single uvToolInstallSync("pipelex", ...)
    expect(uvToolInstallSync).toHaveBeenCalledTimes(1);
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex", PX_CONSTRAINT);
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 4: All ok — no upgrades needed
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_NOT_NEEDED when all binaries are ok", async () => {
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.3.2",
      version_constraint: PLXT_CONSTRAINT,
    });

    await agentUpgrade();

    expect(uvToolInstallSync).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_NOT_NEEDED");
    expect(writeUpgradeMarker).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 5: Partial failure
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_PARTIAL when one succeeds and one fails", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "pipelex" as const,
      runnerUrl: "", platformUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    vi.mocked(checkBinaryVersion)
      // plxt outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: PX_CONSTRAINT,
      })
      // Post-check for plxt (the one that succeeds)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      });

    vi.mocked(uvToolInstallSync)
      .mockImplementationOnce(() => {}) // plxt succeeds
      .mockImplementationOnce(() => {
        throw new Error("Network error");
      }); // pipelex fails

    await agentUpgrade();

    expect(clearCache).not.toHaveBeenCalled();
    expect(clearSnooze).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_PARTIAL");
  });

  // ---------------------------------------------------------------------------
  // Case 6: Missing binary treated as upgrade target
  // ---------------------------------------------------------------------------
  it("treats missing binary as upgrade target", async () => {
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({
        status: "missing",
        installed_version: null,
        version_constraint: PLXT_CONSTRAINT,
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      });

    await agentUpgrade();

    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", PLXT_CONSTRAINT);
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 7: Unparseable binary skipped
  // ---------------------------------------------------------------------------
  it("skips unparseable binary (not included as upgrade target)", async () => {
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "unparseable",
      installed_version: null,
      version_constraint: PLXT_CONSTRAINT,
    });

    await agentUpgrade();

    expect(uvToolInstallSync).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_NOT_NEEDED");
  });

  // ---------------------------------------------------------------------------
  // Case 8: requireUv failure
  // ---------------------------------------------------------------------------
  it("calls agentError with InstallError when requireUv fails", async () => {
    vi.mocked(requireUv).mockImplementation(() => {
      throw new Error("uv is required but not found in PATH");
    });

    await expect(agentUpgrade()).rejects.toThrow("agentError called");

    expect(agentError).toHaveBeenCalledWith(
      expect.stringContaining("uv is required"),
      "InstallError",
      expect.objectContaining({ error_domain: "install" })
    );
    // Verify execution halted — no downstream calls after fatal error
    expect(loadConfig).not.toHaveBeenCalled();
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 9: Marker file contains correct old versions JSON
  // ---------------------------------------------------------------------------
  it("writes marker with correct old versions JSON", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      runner: "pipelex" as const,
      runnerUrl: "", platformUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    vi.mocked(checkBinaryVersion)
      // plxt outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: PX_CONSTRAINT,
      })
      // Post-check for plxt
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: PLXT_CONSTRAINT,
      })
      // Post-check for pipelex-agent
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: PX_CONSTRAINT,
      });

    await agentUpgrade();

    expect(writeUpgradeMarker).toHaveBeenCalledTimes(1);
    expect(writeUpgradeMarker).toHaveBeenCalledWith({
      plxt: "0.3.1",
      pipelex_agent: "0.21.0",
    });
  });

  // ---------------------------------------------------------------------------
  // Case 10: All upgrades fail
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_FAILED when all upgrades fail", async () => {
    vi.mocked(checkBinaryVersion).mockReturnValueOnce({
      status: "outdated",
      installed_version: "0.3.1",
      version_constraint: PLXT_CONSTRAINT,
    });

    vi.mocked(uvToolInstallSync).mockImplementation(() => {
      throw new Error("Network error");
    });

    await agentUpgrade();

    expect(stdoutOutput).toContain("UPGRADE_FAILED");
    expect(clearCache).not.toHaveBeenCalled();
    expect(clearSnooze).not.toHaveBeenCalled();
    expect(writeUpgradeMarker).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 11: Post-upgrade checkBinaryVersion returns "missing" (PATH issue)
  // ---------------------------------------------------------------------------
  it("treats upgrade as successful when post-check returns missing (PATH issue)", async () => {
    vi.mocked(uvToolInstallSync).mockImplementation(() => {}); // reset: install succeeds
    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: PLXT_CONSTRAINT,
      })
      // Post-check: binary not yet visible in PATH
      .mockReturnValueOnce({
        status: "missing",
        installed_version: null,
        version_constraint: PLXT_CONSTRAINT,
      });

    await agentUpgrade();

    // uvToolInstallSync didn't throw, so treat as successful
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
    expect(clearCache).toHaveBeenCalled();
    // newVersion should be null/"unknown" in the output
    expect(stdoutOutput).toContain("unknown");
  });

  // writeUpgradeMarker's own EPERM/fallback/warning behavior is covered in
  // update-cache.test.ts — at this layer we only assert that the upgrade flow
  // invokes it (Case 1 / Case 9) and skips it on failure (Cases 4 / 10).
});
