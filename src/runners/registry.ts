import { loadConfig } from "../config/config.js";
import { Runners } from "./types.js";
import type { Runner, RunnerType } from "./types.js";
import { MthdsApiClient } from "./api/client.js";
import { PipelexRunner } from "./pipelex/runner.js";

export function createRunner(
  type?: RunnerType,
  libraryDirs?: string[]
): Runner {
  const config = loadConfig();
  const runnerType = type ?? config.runner;

  switch (runnerType) {
    case Runners.API:
      // The API client IS the API runner (parity D8). Defaults flow from the
      // resolved config (file + env), so the CLI honors `~/.mthds/config`.
      return new MthdsApiClient({
        baseUrl: config.baseUrl,
        apiToken: config.apiKey || undefined,
      });
    case Runners.PIPELEX:
      return new PipelexRunner(libraryDirs);
    default:
      throw new Error(`Unknown runner type: ${runnerType as string}`);
  }
}
