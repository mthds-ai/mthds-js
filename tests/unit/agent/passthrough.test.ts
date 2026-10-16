import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Problem } from "../../../src/problems/types.js";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/version-check.js", () => ({
  checkBinaryVersion: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/installer.js", () => ({
  uvToolInstallSync: vi.fn(),
}));

// Mock agentError to throw so execution stops (like the real process.exit); the problems and the
// warnings stay the real ones.
class AgentErrorThrow extends Error {
  constructor(
    public problem: Problem,
    public extras?: Record<string, unknown>,
  ) {
    super(problem.code);
  }
}

vi.mock("../../../src/agent/output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/agent/output.js")>()),
  agentError: vi.fn((problem: Problem, extras?: Record<string, unknown>) => {
    throw new AgentErrorThrow(problem, extras);
  }),
}));

const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

import { spawnSync } from "node:child_process";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { uvToolInstallSync } from "../../../src/installer/runtime/installer.js";
import { agentError, chooseErrorFormat } from "../../../src/agent/output.js";
import { passthrough } from "../../../src/agent/passthrough.js";
import { BINARY_RECOVERY } from "../../../src/agent/binaries.js";
import { outcomeNotes, resetOutcomeNotes } from "../../../src/usage-stats/outcome.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;
const PX_AGENT_RECOVERY = BINARY_RECOVERY["pipelex-agent"];

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedCheckBinaryVersion = vi.mocked(checkBinaryVersion);
const mockedUvToolInstallSync = vi.mocked(uvToolInstallSync);
const mockedAgentError = vi.mocked(agentError);

const OK_SPAWN = {
  status: 0,
  error: undefined as unknown as Error,
  pid: 1234,
  output: [],
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  signal: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("passthrough", () => {
  it("spawns the binary and exits with its status code", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run", "--pipe", "test"]);

    expect(mockedSpawnSync).toHaveBeenCalledWith("pipelex-agent", ["run", "--pipe", "test"], {
      stdio: "inherit",
      env: expect.objectContaining({ PIPELEX_USAGE_STATS_HOST: "mthds-agent" }),
    });
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("tells the spawned tool that mthds-agent runs it, over a host the caller declared", () => {
    vi.stubEnv("PIPELEX_USAGE_STATS_HOST", "cocode");
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("plxt", ["lint"], { skipVersionCheck: true });

    const options = mockedSpawnSync.mock.calls.at(-1)![2] as { env: NodeJS.ProcessEnv };
    expect(options.env["PIPELEX_USAGE_STATS_HOST"]).toBe("mthds-agent");
    expect(process.env["PIPELEX_USAGE_STATS_HOST"]).toBe("cocode");
    vi.unstubAllEnvs();
  });

  it("reports a tool killed by the interrupt as a cancelled command", () => {
    resetOutcomeNotes();
    mockedSpawnSync.mockReturnValue({ ...OK_SPAWN, status: null, signal: "SIGINT" } as never);

    passthrough("plxt", ["lint"], { skipVersionCheck: true });

    expect(mockExit).toHaveBeenCalledWith(130);
    expect(outcomeNotes().cancelled).toBe(true);
    resetOutcomeNotes();
  });

  it("reports a tool that handled Ctrl-C and exited 130 as a cancelled command", () => {
    resetOutcomeNotes();
    mockedSpawnSync.mockReturnValue({ ...OK_SPAWN, status: 130, signal: null } as never);

    passthrough("pipelex-agent", ["run", "pipe", "x"], { skipVersionCheck: true });

    expect(mockExit).toHaveBeenCalledWith(130);
    expect(outcomeNotes().cancelled).toBe(true);
    resetOutcomeNotes();
  });

  it("reports a tool that failed with another status as not cancelled", () => {
    resetOutcomeNotes();
    mockedSpawnSync.mockReturnValue({ ...OK_SPAWN, status: 1, signal: null } as never);

    passthrough("pipelex-agent", ["run", "pipe", "x"], { skipVersionCheck: true });

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(outcomeNotes().cancelled).toBe(false);
  });

  it("reports a binary that is not found, with no recovery info, as client.tool_missing", () => {
    const enoentError = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";

    mockedSpawnSync.mockReturnValue({
      ...OK_SPAWN,
      status: null,
      error: enoentError,
      pid: 0,
    });

    // Use a binary with no BINARY_RECOVERY entry so version check is skipped
    expect(() => passthrough("nonexistent-bin", ["run"])).toThrow(AgentErrorThrow);
    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_missing",
        domain: "input",
        params: { tool: "nonexistent-bin" },
        message: expect.stringContaining("not found"),
      }),
      { recovery: undefined },
    );
  });

  it("proceeds without install when version is ok and autoInstall is true", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("auto-installs when binary is missing and autoInstall is true", () => {
    mockedCheckBinaryVersion
      .mockReturnValueOnce({
        status: "missing",
        installed_version: null,
        version_constraint: PX_CONSTRAINT,
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: PX_CONSTRAINT,
      });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalledWith("pipelex", PX_CONSTRAINT);
    expect(mockedSpawnSync).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("auto-upgrades when binary is outdated and autoInstall is true", () => {
    mockedCheckBinaryVersion
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.20.0",
        version_constraint: PX_CONSTRAINT,
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: PX_CONSTRAINT,
      });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalledWith("pipelex", PX_CONSTRAINT);
    expect(mockedSpawnSync).toHaveBeenCalled();
  });

  it("warns to stderr when upgrade does not satisfy constraint", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockedCheckBinaryVersion.mockReturnValue({
      status: "outdated",
      installed_version: "0.20.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("may not have taken effect"));
    // Still proceeds to spawn despite warning
    expect(mockedSpawnSync).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("warns to stderr but still spawns when version is unparseable", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockedCheckBinaryVersion.mockReturnValue({
      status: "unparseable",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Could not parse version"));
    expect(mockedUvToolInstallSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("writes the unparseable-version warning as JSON, with the constraint, under --error-format json", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    chooseErrorFormat("json");
    try {
      mockedCheckBinaryVersion.mockReturnValue({
        status: "unparseable",
        installed_version: null,
        version_constraint: PX_CONSTRAINT,
      });
      mockedSpawnSync.mockReturnValue(OK_SPAWN);

      passthrough("pipelex-agent", ["run"], { autoInstall: true });

      expect(JSON.parse(String(stderrSpy.mock.calls[0]![0]))).toEqual({
        warning: true,
        message: "Could not parse version for pipelex-agent. Proceeding anyway.",
        version_constraint: PX_CONSTRAINT,
      });
    } finally {
      chooseErrorFormat(undefined);
      stderrSpy.mockRestore();
    }
  });

  it("reports a failed auto-upgrade as client.tool_outdated, with its recovery", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "outdated",
      installed_version: "0.20.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedUvToolInstallSync.mockImplementation(() => {
      throw new Error("Network error");
    });

    expect(() => passthrough("pipelex-agent", ["run"], { autoInstall: true })).toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_outdated",
        params: { tool: "pipelex-agent", version: "0.20.0" },
        message: expect.stringContaining("Network error"),
      }),
      { recovery: PX_AGENT_RECOVERY },
    );
  });

  it("reports a failed auto-install as client.tool_missing, with its recovery", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedUvToolInstallSync.mockImplementation(() => {
      throw new Error("Network error");
    });

    expect(() => passthrough("pipelex-agent", ["run"], { autoInstall: true })).toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_missing",
        params: { tool: "pipelex-agent" },
        message: expect.stringContaining("Network error"),
      }),
      { recovery: PX_AGENT_RECOVERY },
    );
  });

  it("reports a binary not reachable after auto-install as client.tool_missing", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedUvToolInstallSync.mockImplementation(() => {}); // install "succeeds"

    expect(() => passthrough("pipelex-agent", ["run"], { autoInstall: true })).toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_missing",
        params: { tool: "pipelex-agent" },
        message: expect.stringContaining("not reachable"),
      }),
      { recovery: PX_AGENT_RECOVERY },
    );
  });

  // ── 9c: Version check runs unconditionally when recovery exists ──────

  it("reports a missing binary as client.tool_missing when autoInstall=false", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });

    expect(() => passthrough("pipelex-agent", ["run"], { autoInstall: false })).toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_missing",
        params: { tool: "pipelex-agent" },
        message: expect.stringMatching(/not installed.*Install: uv tool install/),
      }),
      { recovery: PX_AGENT_RECOVERY },
    );
    expect(mockedUvToolInstallSync).not.toHaveBeenCalled();
  });

  it("reports an outdated binary as client.tool_outdated with its version when autoInstall=false", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "outdated",
      installed_version: "0.20.0",
      version_constraint: PX_CONSTRAINT,
    });

    expect(() => passthrough("pipelex-agent", ["run"], { autoInstall: false })).toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.tool_outdated",
        params: { tool: "pipelex-agent", version: "0.20.0" },
        message: expect.stringMatching(/outdated.*Upgrade: uv tool install/),
      }),
      { recovery: PX_AGENT_RECOVERY },
    );
    expect(mockedUvToolInstallSync).not.toHaveBeenCalled();
  });

  it("checks version even without autoInstall when recovery exists", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"]); // no autoInstall option at all

    expect(mockedCheckBinaryVersion).toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalled();
  });

  it("skips version check when skipVersionCheck is true", () => {
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], {
      autoInstall: true,
      skipVersionCheck: true,
    });

    expect(mockedCheckBinaryVersion).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalledWith("pipelex-agent", ["run"], {
      stdio: "inherit",
      env: expect.objectContaining({ PIPELEX_USAGE_STATS_HOST: "mthds-agent" }),
    });
  });
});
