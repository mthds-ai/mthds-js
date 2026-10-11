import { beforeEach, describe, expect, it, vi } from "vitest";

// Every `pipelex` and `pipelex-agent` process a pipelex runner starts for mthds-agent carries
// PIPELEX_USAGE_STATS_HOST=mthds-agent, as the agent's passthrough does, so their usage statistics
// say that mthds-agent ran them; one started for the mthds CLI carries no host of ours.

const { execFileAsync } = vi.hoisted(() => ({
  execFileAsync: vi.fn().mockResolvedValue({ stdout: "pipelex 0.0.0\n", stderr: "" }),
}));

vi.mock("node:child_process", () => {
  const execFileMock = vi.fn() as ReturnType<typeof vi.fn> & Record<string | symbol, unknown>;
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = execFileAsync;
  return { execFile: execFileMock, spawn: vi.fn() };
});

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...original,
    loadConfig: vi.fn(() => ({
      runner: "pipelex",
      baseUrl: "https://api.pipelex.com",
      apiKey: "",
    })),
  };
});

import { spawn } from "node:child_process";
import { createRunner } from "../../../src/runners/registry.js";
import type { PipelexRunner } from "../../../src/runners/pipelex/runner.js";

const mockedSpawn = vi.mocked(spawn);

/** Make `spawn` return a fake child that exits 0. */
function spawnSucceeds(): void {
  mockedSpawn.mockReturnValue({
    on(event: string, callback: (code: number) => void) {
      if (event === "close") callback(0);
      return this;
    },
  } as unknown as ReturnType<typeof spawn>);
}

/** The environment each spawn of `runner` was given, across every kind of call it makes. */
async function spawnEnvironments(
  runner: PipelexRunner,
): Promise<(NodeJS.ProcessEnv | undefined)[]> {
  spawnSucceeds();
  await runner.version();
  execFileAsync.mockResolvedValueOnce({ stdout: "{}", stderr: "" });
  await runner.models();
  execFileAsync.mockResolvedValueOnce({ stdout: '{"success":true}', stderr: "" });
  await runner.checkModel({ reference: "gpt-4o", type: "llm" });
  await runner.runPassthrough(["pipe", "x"]);
  await runner.validatePassthrough(["bundle", "x.mthds"]);
  const fromExec = execFileAsync.mock.calls.map(
    (call) => (call[2] as { env?: NodeJS.ProcessEnv }).env,
  );
  const fromSpawn = mockedSpawn.mock.calls.map(
    (call) => (call[2] as { env?: NodeJS.ProcessEnv }).env,
  );
  return [...fromExec, ...fromSpawn];
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsync.mockResolvedValue({ stdout: "pipelex 0.0.0\n", stderr: "" });
});

describe("the pipelex runner's spawns", () => {
  it("name mthds-agent as the host when the runner is created for mthds-agent", async () => {
    const runner = createRunner("mthds-agent", "pipelex") as PipelexRunner;
    const environments = await spawnEnvironments(runner);
    expect(environments.length).toBeGreaterThanOrEqual(5);
    for (const env of environments) {
      expect(env?.["PIPELEX_USAGE_STATS_HOST"]).toBe("mthds-agent");
      expect(env?.["PATH"]).toBe(process.env["PATH"]);
    }
  });

  it("declare no host when the runner is created for the mthds CLI", async () => {
    const runner = createRunner("mthds-cli", "pipelex") as PipelexRunner;
    const environments = await spawnEnvironments(runner);
    for (const env of environments) {
      expect(env?.["PIPELEX_USAGE_STATS_HOST"]).toBeUndefined();
    }
  });
});
