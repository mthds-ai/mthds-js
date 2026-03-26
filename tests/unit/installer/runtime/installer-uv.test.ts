import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

// Must also mock ora and check.js since installer.ts imports them at module level
vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
}));

vi.mock("../../../../src/installer/runtime/check.js", () => ({
  isPipelexInstalled: vi.fn(() => true),
}));

import { execFileSync } from "node:child_process";
import { requireUv, uvToolInstallSync } from "../../../../src/installer/runtime/installer.js";

const mockedExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireUv", () => {
  it("returns 'uv' when uv is available", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("uv 0.7.2"));

    const result = requireUv();

    expect(result).toBe("uv");
    expect(mockedExecFileSync).toHaveBeenCalledWith("uv", ["--version"], {
      stdio: "ignore",
    });
  });

  it("throws with install URL when uv is not found (ENOENT)", () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedExecFileSync.mockImplementation(() => { throw err; });

    expect(() => requireUv()).toThrow("uv is required but not found");
    expect(() => requireUv()).toThrow("https://docs.astral.sh/uv");
  });

  it("throws with actual error when uv exists but fails (non-ENOENT)", () => {
    const err = new Error("Permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockedExecFileSync.mockImplementation(() => { throw err; });

    expect(() => requireUv()).toThrow("uv was found but failed to run");
    expect(() => requireUv()).toThrow("Permission denied");
  });
});

describe("uvToolInstallSync", () => {
  it("calls execFileSync with correct args and version constraint", () => {
    // requireUv check succeeds
    mockedExecFileSync
      .mockReturnValueOnce(Buffer.from("uv 0.7.2")) // requireUv
      .mockReturnValueOnce(Buffer.from("")); // actual install

    uvToolInstallSync("pipelex", ">=0.22.0");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "uv",
      ["tool", "install", "--upgrade", "pipelex>=0.22.0"],
      { stdio: "pipe" }
    );
  });

  it("calls without version spec when no constraint given", () => {
    mockedExecFileSync
      .mockReturnValueOnce(Buffer.from("uv 0.7.2"))
      .mockReturnValueOnce(Buffer.from(""));

    uvToolInstallSync("pipelex");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "uv",
      ["tool", "install", "--upgrade", "pipelex"],
      { stdio: "pipe" }
    );
  });

  it("propagates errors with stderr detail from uv", () => {
    const uvError = new Error("Command failed") as Error & { stderr?: Buffer };
    uvError.stderr = Buffer.from("No matching distribution found for nonexistent>=1.0.0");
    mockedExecFileSync
      .mockReturnValueOnce(Buffer.from("uv 0.7.2")) // requireUv
      .mockImplementationOnce(() => { throw uvError; });

    expect(() => uvToolInstallSync("nonexistent", ">=1.0.0")).toThrow(
      'uv tool install failed for "nonexistent>=1.0.0"'
    );
    expect(() => {
      mockedExecFileSync
        .mockReturnValueOnce(Buffer.from("uv 0.7.2"))
        .mockImplementationOnce(() => { throw uvError; });
      uvToolInstallSync("nonexistent", ">=1.0.0");
    }).toThrow("No matching distribution found");
  });

  it("throws requireUv error when uv is missing", () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedExecFileSync.mockImplementation(() => { throw err; });

    expect(() => uvToolInstallSync("pipelex")).toThrow(
      "uv is required but not found"
    );
  });
});
