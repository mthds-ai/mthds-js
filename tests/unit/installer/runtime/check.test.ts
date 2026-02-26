import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  isBinaryInstalled,
  isPipelexInstalled,
  isPlxtInstalled,
} from "../../../../src/installer/runtime/check.js";

const mockedExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isBinaryInstalled", () => {
  it("returns true when execFileSync succeeds", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("1.0.0"));
    expect(isBinaryInstalled("plxt")).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith("plxt", ["--version"], {
      stdio: "ignore",
    });
  });

  it("returns false when execFileSync throws", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isBinaryInstalled("nonexistent")).toBe(false);
  });
});

describe("isPipelexInstalled", () => {
  it("checks for pipelex binary", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(""));
    isPipelexInstalled();
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "pipelex",
      ["--version"],
      { stdio: "ignore" }
    );
  });
});

describe("isPlxtInstalled", () => {
  it("checks for plxt binary", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(""));
    isPlxtInstalled();
    expect(mockedExecFileSync).toHaveBeenCalledWith("plxt", ["--version"], {
      stdio: "ignore",
    });
  });
});
