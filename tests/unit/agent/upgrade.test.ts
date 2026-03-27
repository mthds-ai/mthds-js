import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VersionCheckResult } from "../../../src/installer/runtime/version-check.js";

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

vi.mock("../../../src/installer/runtime/installer.js", () => ({
  requireUv: vi.fn(() => "uv"),
  uvToolInstallSync: vi.fn(),
}));

vi.mock("../../../src/agent/update-cache.js", () => ({
  STATE_DIR: "/tmp/mthds-test-state",
  clearCache: vi.fn(),
  ensureStateDir: vi.fn(),
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

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────

import { agentUpgrade } from "../../../src/agent/commands/upgrade.js";
import { loadCredentials } from "../../../src/config/credentials.js";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { requireUv, uvToolInstallSync } from "../../../src/installer/runtime/installer.js";
import { clearCache, ensureStateDir } from "../../../src/agent/update-cache.js";
import { clearSnooze } from "../../../src/agent/snooze.js";
import { agentError } from "../../../src/agent/output.js";
import { writeFileSync } from "node:fs";

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
    vi.mocked(loadCredentials).mockReturnValue({
      runner: "api" as const,
      apiUrl: "",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });
    vi.mocked(requireUv).mockReturnValue("uv");
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: ">=0.22.0",
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
        version_constraint: ">=0.3.2",
      })
      // Post-check after upgrade
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
      });

    await agentUpgrade();

    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", ">=0.3.2");
    expect(writeFileSync).toHaveBeenCalled();
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 2: Upgrades both pipelex-agent and plxt (runner=pipelex)
  // ---------------------------------------------------------------------------
  it("upgrades both pipelex-agent and plxt (runner=pipelex)", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      runner: "pipelex" as const,
      apiUrl: "",
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
        version_constraint: ">=0.3.2",
      })
      // pipelex-agent check
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: ">=0.22.0",
      })
      // Post-check for plxt (pipelex-tools)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
      })
      // Post-check for pipelex-agent (pipelex)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: ">=0.22.0",
      });

    await agentUpgrade();

    // Two different uv_packages: pipelex-tools and pipelex
    expect(uvToolInstallSync).toHaveBeenCalledTimes(2);
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", ">=0.3.2");
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex", ">=0.22.0");
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 3: De-duplicates shared uv_package
  // ---------------------------------------------------------------------------
  it("de-duplicates shared uv_package (pipelex + pipelex-agent)", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      runner: "pipelex" as const,
      apiUrl: "",
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
        version_constraint: ">=0.3.2",
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: ">=0.22.0",
      })
      // Post-check for pipelex
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: ">=0.22.0",
      });

    await agentUpgrade();

    // Only pipelex-agent is outdated → single uvToolInstallSync("pipelex", ...)
    expect(uvToolInstallSync).toHaveBeenCalledTimes(1);
    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex", ">=0.22.0");
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 4: All ok — no upgrades needed
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_NOT_NEEDED when all binaries are ok", async () => {
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "ok",
      installed_version: "0.3.2",
      version_constraint: ">=0.3.2",
    });

    await agentUpgrade();

    expect(uvToolInstallSync).not.toHaveBeenCalled();
    expect(stdoutOutput).toContain("UPGRADE_NOT_NEEDED");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 5: Partial failure
  // ---------------------------------------------------------------------------
  it("outputs UPGRADE_PARTIAL when one succeeds and one fails", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      runner: "pipelex" as const,
      apiUrl: "",
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
        version_constraint: ">=0.3.2",
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: ">=0.22.0",
      })
      // Post-check for plxt (the one that succeeds)
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
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
        version_constraint: ">=0.3.2",
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
      });

    await agentUpgrade();

    expect(uvToolInstallSync).toHaveBeenCalledWith("pipelex-tools", ">=0.3.2");
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
  });

  // ---------------------------------------------------------------------------
  // Case 7: Unparseable binary skipped
  // ---------------------------------------------------------------------------
  it("skips unparseable binary (not included as upgrade target)", async () => {
    vi.mocked(checkBinaryVersion).mockReturnValue({
      status: "unparseable",
      installed_version: null,
      version_constraint: ">=0.3.2",
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

    expect(() => agentUpgrade()).toThrow("agentError called");

    expect(agentError).toHaveBeenCalledWith(
      expect.stringContaining("uv is required"),
      "InstallError",
      expect.objectContaining({ error_domain: "install" })
    );
    // Verify execution halted — no downstream calls after fatal error
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(checkBinaryVersion).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Case 9: Marker file contains correct old versions JSON
  // ---------------------------------------------------------------------------
  it("writes marker with correct old versions JSON", async () => {
    vi.mocked(loadCredentials).mockReturnValue({
      runner: "pipelex" as const,
      apiUrl: "",
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
        version_constraint: ">=0.3.2",
      })
      // pipelex-agent outdated
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.21.0",
        version_constraint: ">=0.22.0",
      })
      // Post-check for plxt
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
      })
      // Post-check for pipelex-agent
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: ">=0.22.0",
      });

    await agentUpgrade();

    expect(ensureStateDir).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/mthds-test-state/just-upgraded-from",
      expect.any(String),
      "utf-8"
    );

    // Verify the marker JSON content
    const markerContent = vi.mocked(writeFileSync).mock.calls[0]![1] as string;
    const parsed = JSON.parse(markerContent);
    expect(parsed).toEqual({
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
      version_constraint: ">=0.3.2",
    });

    vi.mocked(uvToolInstallSync).mockImplementation(() => {
      throw new Error("Network error");
    });

    await agentUpgrade();

    expect(stdoutOutput).toContain("UPGRADE_FAILED");
    expect(clearCache).not.toHaveBeenCalled();
    expect(clearSnooze).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
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
        version_constraint: ">=0.3.2",
      })
      // Post-check: binary not yet visible in PATH
      .mockReturnValueOnce({
        status: "missing",
        installed_version: null,
        version_constraint: ">=0.3.2",
      });

    await agentUpgrade();

    // uvToolInstallSync didn't throw, so treat as successful
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
    expect(clearCache).toHaveBeenCalled();
    // newVersion should be null/"unknown" in the output
    expect(stdoutOutput).toContain("unknown");
  });

  // ---------------------------------------------------------------------------
  // Case 12: writeFileSync for marker throws
  // ---------------------------------------------------------------------------
  it("still reports results to stdout when marker writeFileSync throws", async () => {
    vi.mocked(uvToolInstallSync).mockImplementation(() => {}); // reset: install succeeds

    const stderrOutput: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(String(chunk));
      return true;
    });

    vi.mocked(checkBinaryVersion)
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.3.1",
        version_constraint: ">=0.3.2",
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.3.2",
        version_constraint: ">=0.3.2",
      });

    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await agentUpgrade();

    // Marker write failed, but results still reported
    expect(stdoutOutput).toContain("UPGRADE_COMPLETE");
    expect(stderrOutput.join("")).toContain("could not write upgrade marker");
    // Cache + snooze still cleared (upgrade itself succeeded)
    expect(clearCache).toHaveBeenCalled();
    expect(clearSnooze).toHaveBeenCalled();
  });
});
