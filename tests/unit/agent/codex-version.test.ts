import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock child_process so no real `codex` binary is invoked ─────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  detectCodexVersion,
  codexVersionWarning,
  MIN_CODEX_VERSION,
  CODEX_VERSION_TOO_OLD,
} from "../../../src/agent/codex-version.js";

const mockedExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("detectCodexVersion", () => {
  it("parses the semver out of `codex --version` output", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.142.5\n"));

    expect(detectCodexVersion()).toBe("0.142.5");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it("returns null when the output has no semver", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli development build"));

    expect(detectCodexVersion()).toBeNull();
  });

  it("returns null when the output is empty", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(""));

    expect(detectCodexVersion()).toBeNull();
  });

  it("returns null (never throws) when the binary is missing or fails", () => {
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(detectCodexVersion()).toBeNull();
  });
});

describe("codexVersionWarning", () => {
  it("warns when the detected Codex is older than the supported floor", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.130.0"));

    const warning = codexVersionWarning();
    expect(warning).not.toBeNull();
    expect(warning!.code).toBe(CODEX_VERSION_TOO_OLD);
    expect(warning!.message).toContain("0.130.0");
    expect(warning!.message).toContain(MIN_CODEX_VERSION);
    expect(warning!.message).toContain("Upgrade Codex");
  });

  it("returns null when the detected Codex meets the floor exactly", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(`codex-cli ${MIN_CODEX_VERSION}`));

    expect(codexVersionWarning()).toBeNull();
  });

  it("returns null when the detected Codex is newer than the floor", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli 99.0.0"));

    expect(codexVersionWarning()).toBeNull();
  });

  it("returns null when the version cannot be detected", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });

    expect(codexVersionWarning()).toBeNull();
  });
});
