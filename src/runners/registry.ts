import { loadConfig } from "../config/config.js";
import { Runners } from "./types.js";
import type { Runner, RunnerType } from "./types.js";
import { ApiRunner } from "./api-runner.js";
import { PipelexRunner } from "./pipelex-runner.js";

export function createRunner(
  type?: RunnerType,
  libraryDirs?: string[]
): Runner {
  const runnerType = type ?? loadConfig().runner;

  switch (runnerType) {
    case Runners.API:
      return new ApiRunner();
    case Runners.PIPELEX:
      return new PipelexRunner(libraryDirs);
    default:
      throw new Error(`Unknown runner type: ${runnerType as string}`);
  }
}
