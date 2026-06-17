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

  it("validates the bundle leniently with -L and --allow-signatures", () => {
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
    ]);
    expect(result).toEqual({ exitCode: 0, stderr: "" });
  });

  it("passes a non-zero exit code and stderr through unchanged", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stderr: "# Error: ValidateBundleError\n" });

    const result = runPipelexValidate("a.mthds", "./");

    expect(result).toEqual({ exitCode: 1, stderr: "# Error: ValidateBundleError\n" });
  });

  it("maps a spawn failure (binary missing) to exit 127 with the error message", () => {
    spawnSyncMock.mockReturnValue({ error: new Error("spawn ENOENT"), status: null, stderr: "" });

    const result = runPipelexValidate("a.mthds", "./");

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("ENOENT");
  });
});
