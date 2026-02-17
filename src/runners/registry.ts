import { loadConfig } from "../config/config.js";
import type { Runner, RunnerType } from "./types.js";
import { ApiRunner } from "./api-runner.js";
import { PipelexRunner } from "./pipelex-runner.js";

export function createRunner(type?: RunnerType): Runner {
  const runnerType = type ?? loadConfig().runner;

  switch (runnerType) {
    case "api":
      return new ApiRunner();
    case "pipelex":
      return new PipelexRunner();
    default:
      throw new Error(`Unknown runner type: ${runnerType as string}`);
  }
}
