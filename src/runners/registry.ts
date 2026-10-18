import { problemError } from "../problems/errors.js";
import { loadConfig } from "../config/config.js";
import { Runners } from "./types.js";
import type { Runner, RunnerType } from "./types.js";
import { MthdsApiClient } from "./api/client.js";
import type { AppInfo } from "./api/user-agent.js";
import { PipelexRunner } from "./pipelex/runner.js";
import { MTHDS_JS_VERSION } from "../version.js";
import { mthdsAgentChildEnv } from "../usage-stats/environment.js";

/**
 * The program a runner is created for — the two binaries this package ships.
 * Each is a row of the closed token registry in the spec
 * `conformance/specs/client-identification.md`, in the conformance repo, and
 * names itself in front of `mthds-js/<version>` in the API runner's `User-Agent`.
 */
export type CliCaller = "mthds-cli" | "mthds-agent";

/** The `appInfo` each binary sends: its token name at this package's version. */
export function cliAppInfo(caller: CliCaller): AppInfo {
  return { name: caller, version: MTHDS_JS_VERSION };
}

/**
 * Create the runner a CLI command uses. `caller` is required so no call site
 * can reach the API without naming the binary it runs in.
 */
export function createRunner(caller: CliCaller, type?: RunnerType, libraryDirs?: string[]): Runner {
  const config = loadConfig();
  const runnerType = type ?? config.runner;

  switch (runnerType) {
    case Runners.API:
      // The API client IS the API runner (parity D8). Defaults flow from the
      // resolved config (file + env), so the CLI honors `~/.mthds/config`.
      return new MthdsApiClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey || undefined,
        appInfo: cliAppInfo(caller),
      });
    case Runners.PIPELEX:
      // The `pipelex` and `pipelex-agent` processes it starts for mthds-agent say so in their
      // usage statistics, as those the agent's passthrough starts do.
      return new PipelexRunner(
        libraryDirs,
        caller === "mthds-agent" ? { env: mthdsAgentChildEnv() } : {},
      );
    default:
      throw problemError(
        "client.not_configured",
        { setting: "runner" },
        { message: `Unknown runner type: ${runnerType as string}` },
      );
  }
}
