import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/check.js", () => ({
  isBinaryInstalled: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/installer.js", () => ({
  installPipelexSync: vi.fn(),
  installPlxtSync: vi.fn(),
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
import { isBinaryInstalled } from "../../../src/installer/runtime/check.js";
import { installPipelexSync } from "../../../src/installer/runtime/installer.js";
import { agentError } from "../../../src/agent/output.js";
import { passthrough } from "../../../src/agent/passthrough.js";

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedIsBinaryInstalled = vi.mocked(isBinaryInstalled);
const mockedInstallPipelexSync = vi.mocked(installPipelexSync);
const mockedAgentError = vi.mocked(agentError);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("passthrough", () => {
  it("spawns the binary and exits with its status code", () => {
    mockedSpawnSync.mockReturnValue({
      status: 0,
      error: undefined as unknown as Error,
      pid: 1234,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      signal: null,
    });

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
      status: null,
      error: enoentError,
      pid: 0,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      signal: null,
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

  it("attempts auto-install when binary is missing and autoInstall is true", () => {
    mockedIsBinaryInstalled
      .mockReturnValueOnce(false) // initial check: not installed
      .mockReturnValueOnce(true); // post-install check: now installed

    mockedSpawnSync.mockReturnValue({
      status: 0,
      error: undefined as unknown as Error,
      pid: 1234,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      signal: null,
    });

    passthrough("pipelex-agent", ["run"], { autoInstall: true });

    expect(mockedInstallPipelexSync).toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("emits InstallError when auto-install fails", () => {
    mockedIsBinaryInstalled.mockReturnValue(false);
    mockedInstallPipelexSync.mockImplementation(() => {
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
    mockedInstallPipelexSync.mockImplementation(() => {}); // install "succeeds"
    mockedIsBinaryInstalled
      .mockReturnValueOnce(false) // initial check
      .mockReturnValueOnce(false); // post-install check: still not found

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
