import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock child_process so no real `codex` binary is invoked ─────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  detectCodexVersion,
  assessCodexVersion,
  MIN_CODEX_VERSION,
  CODEX_PLUGIN_HOOKS_MIN,
  CODEX_VERSION_TOO_OLD,
  CODEX_HOOKS_UNAVAILABLE,
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

describe("assessCodexVersion", () => {
  it("errors when the detected Codex cannot load plugin-bundled hooks (< 0.131)", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.130.0"));

    const finding = assessCodexVersion();
    expect(finding).not.toBeNull();
    expect(finding!.code).toBe(CODEX_HOOKS_UNAVAILABLE);
    expect(finding!.severity).toBe("error");
    expect(finding!.message).toContain("0.130.0");
    expect(finding!.message).toContain("cannot load plugin-bundled hooks");
    expect(finding!.message).toContain(MIN_CODEX_VERSION);
  });

  it("warns when the detected Codex loads hooks but is below the tested floor", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(`codex-cli ${CODEX_PLUGIN_HOOKS_MIN}`));

    const finding = assessCodexVersion();
    expect(finding).not.toBeNull();
    expect(finding!.code).toBe(CODEX_VERSION_TOO_OLD);
    expect(finding!.severity).toBe("warning");
    expect(finding!.message).toContain(CODEX_PLUGIN_HOOKS_MIN);
    expect(finding!.message).toContain(MIN_CODEX_VERSION);
    expect(finding!.message).toContain("Upgrade Codex");
  });

  it("returns null when the detected Codex meets the floor exactly", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from(`codex-cli ${MIN_CODEX_VERSION}`));

    expect(assessCodexVersion()).toBeNull();
  });

  it("returns null when the detected Codex is newer than the floor", () => {
    mockedExecFileSync.mockReturnValue(Buffer.from("codex-cli 99.0.0"));

    expect(assessCodexVersion()).toBeNull();
  });

  it("returns null when the version cannot be detected", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("spawn codex ENOENT");
    });

    expect(assessCodexVersion()).toBeNull();
  });
});
