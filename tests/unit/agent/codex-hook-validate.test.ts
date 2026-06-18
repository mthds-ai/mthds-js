import { describe, it, expect, vi, beforeEach } from "vitest";

// Intercept the real spawnSync so we can assert the exact argv the Stage 3
// wrapper builds — the dependency-injected runCodexHook tests mock at the
// runPipelexValidate boundary and never reach this layer, so the
// `--allow-signatures` flag (and the rest of the invocation shape) is only
// observable here.
const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import { runPipelexValidate } from "../../../src/agent/commands/codex-hook.js";

describe("runPipelexValidate — Stage 3 invocation shape", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("validates the bundle leniently with -L, --allow-signatures, and JSON formats", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: "" });

    const result = runPipelexValidate("bundles/core.mthds", "bundles/");

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnSyncMock.mock.calls[0]!;
    expect(cmd).toBe("pipelex-agent");
    expect(args).toEqual([
      "validate",
      "bundle",
      "bundles/core.mthds",
      "-L",
      "bundles/",
      "--allow-signatures",
      "--format",
      "json",
      "--error-format",
      "json",
    ]);
    expect(result).toEqual({ exitCode: 0, stderr: "" });
  });

  it("passes a non-zero exit code and stderr (the JSON error envelope) through unchanged", () => {
    const stderr = JSON.stringify({ error: true, is_valid: false, error_domain: "input" });
    spawnSyncMock.mockReturnValue({ status: 1, stderr });

    const result = runPipelexValidate("a.mthds", "./");

    expect(result).toEqual({ exitCode: 1, stderr });
  });

  it("maps a spawn failure (binary missing) to exit 127 with the error message", () => {
    spawnSyncMock.mockReturnValue({ error: new Error("spawn ENOENT"), status: null, stderr: "" });

    const result = runPipelexValidate("a.mthds", "./");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("ENOENT");
  });
});
