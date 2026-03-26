import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Mock agentError to throw so execution stops (like the real process.exit)
class AgentErrorThrow extends Error {
  constructor(
    public errorType: string,
    public extras?: Record<string, unknown>
  ) {
    super(errorType);
  }
}

vi.mock("../../../src/agent/output.js", () => ({
  agentError: vi.fn(
    (message: string, errorType: string, extras?: Record<string, unknown>) => {
      throw new AgentErrorThrow(errorType, { message, ...extras });
    }
  ),
  AGENT_ERROR_DOMAINS: {
    ARGUMENT: "argument",
    CONFIG: "config",
    RUNNER: "runner",
    PIPELINE: "pipeline",
    VALIDATION: "validation",
    INSTALL: "install",
    IO: "io",
    BINARY: "binary",
  },
}));

const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

import { spawnSync } from "node:child_process";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { uvToolInstallSync } from "../../../src/installer/runtime/installer.js";
import { agentError } from "../../../src/agent/output.js";
import { passthrough } from "../../../src/agent/passthrough.js";

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
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run", "--pipe", "test"]);

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "pipelex-agent",
      ["run", "--pipe", "test"],
      { stdio: "inherit" }
    );
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("emits BinaryNotFoundError on ENOENT", () => {
    const enoentError = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";

    mockedSpawnSync.mockReturnValue({
      ...OK_SPAWN,
      status: null,
      error: enoentError,
      pid: 0,
    });

    expect(() => passthrough("pipelex-agent", ["run"])).toThrow(AgentErrorThrow);
    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "BinaryNotFoundError",
      expect.objectContaining({
        error_domain: "binary",
        recovery: expect.objectContaining({ binary: "pipelex-agent" }),
      })
    );
  });

  it("proceeds without install when version is ok and autoInstall is true", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: ">=0.22.0",
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
        version_constraint: ">=0.22.0",
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: ">=0.22.0",
      });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalledWith("pipelex", ">=0.22.0");
    expect(mockedSpawnSync).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("auto-upgrades when binary is outdated and autoInstall is true", () => {
    mockedCheckBinaryVersion
      .mockReturnValueOnce({
        status: "outdated",
        installed_version: "0.20.0",
        version_constraint: ">=0.22.0",
      })
      .mockReturnValueOnce({
        status: "ok",
        installed_version: "0.22.0",
        version_constraint: ">=0.22.0",
      });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalledWith("pipelex", ">=0.22.0");
    expect(mockedSpawnSync).toHaveBeenCalled();
  });

  it("warns to stderr when upgrade does not satisfy constraint", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockedCheckBinaryVersion.mockReturnValue({
      status: "outdated",
      installed_version: "0.20.0",
      version_constraint: ">=0.22.0",
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedUvToolInstallSync).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("may not have taken effect")
    );
    // Still proceeds to spawn despite warning
    expect(mockedSpawnSync).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("warns to stderr but still spawns when version is unparseable", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockedCheckBinaryVersion.mockReturnValue({
      status: "unparseable",
      installed_version: null,
      version_constraint: ">=0.22.0",
    });
    mockedSpawnSync.mockReturnValue(OK_SPAWN);

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Could not parse version")
    );
    expect(mockedUvToolInstallSync).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("emits InstallError when auto-install fails", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: ">=0.22.0",
    });
    mockedUvToolInstallSync.mockImplementation(() => {
      throw new Error("Network error");
    });

    expect(() =>
      passthrough("pipelex-agent", ["run"], { autoInstall: true })
    ).toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("Network error"),
      "InstallError",
      expect.objectContaining({ error_domain: "install" })
    );
  });

  it("emits InstallError when binary not reachable after auto-install", () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: ">=0.22.0",
    });
    mockedUvToolInstallSync.mockImplementation(() => {}); // install "succeeds"

    expect(() =>
      passthrough("pipelex-agent", ["run"], { autoInstall: true })
    ).toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("not reachable"),
      "InstallError",
      expect.objectContaining({ error_domain: "install" })
    );
  });
});
