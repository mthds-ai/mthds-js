import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/check.js", () => ({
  isPipelexInstalled: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/installer.js", () => ({
  ensureRuntime: vi.fn(),
}));

vi.mock("../../../src/cli/commands/index.js", () => ({
  printLogo: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    step: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

import { spawn } from "node:child_process";
import { isPipelexInstalled } from "../../../src/installer/runtime/check.js";
import { ensureRuntime } from "../../../src/installer/runtime/installer.js";
import { login } from "../../../src/cli/commands/login.js";
import type { ChildProcess } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);
const mockedIsPipelexInstalled = vi.mocked(isPipelexInstalled);
const mockedEnsureRuntime = vi.mocked(ensureRuntime);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("login", () => {
  it("spawns pipelex login with stdio inherit", async () => {
    mockedIsPipelexInstalled.mockReturnValue(true);

    const fakeChild = {
      on: vi.fn((event: string, cb: (code: number | null) => void) => {
        if (event === "close") {
          cb(0);
        }
        return fakeChild;
      }),
    } as unknown as ChildProcess;

    mockedSpawn.mockReturnValue(fakeChild);

    await login();

    expect(mockedSpawn).toHaveBeenCalledWith("pipelex", ["login", "--no-logo"], {
      stdio: "inherit",
    });
  });

  it("installs pipelex if not found", async () => {
    mockedIsPipelexInstalled
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    mockedEnsureRuntime.mockResolvedValue();

    const fakeChild = {
      on: vi.fn((event: string, cb: (code: number | null) => void) => {
        if (event === "close") {
          cb(0);
        }
        return fakeChild;
      }),
    } as unknown as ChildProcess;

    mockedSpawn.mockReturnValue(fakeChild);

    await login();

    expect(mockedEnsureRuntime).toHaveBeenCalled();
    expect(mockedSpawn).toHaveBeenCalled();
  });

  it("exits if pipelex not reachable after install", async () => {
    mockedIsPipelexInstalled.mockReturnValue(false);
    mockedEnsureRuntime.mockResolvedValue();

    const exitError = new Error("process.exit(1)");
    mockExit.mockImplementation((() => {
      throw exitError;
    }) as never);

    await expect(login()).rejects.toThrow(exitError);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("rejects if pipelex login exits with non-zero code", async () => {
    mockedIsPipelexInstalled.mockReturnValue(true);

    const fakeChild = {
      on: vi.fn((event: string, cb: (code: number | null) => void) => {
        if (event === "close") {
          cb(1);
        }
        return fakeChild;
      }),
    } as unknown as ChildProcess;

    mockedSpawn.mockReturnValue(fakeChild);

    await expect(login()).rejects.toThrow("pipelex login exited with code 1");
  });
});
