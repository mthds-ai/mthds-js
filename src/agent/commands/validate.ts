/**
 * Agent validate command — validates a .mthds bundle and outputs JSON.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import type { RunnerType } from "../../runners/types.js";

export async function agentValidate(
  target: string,
  options: {
    pipe?: string;
    bundle?: string;
    runner?: RunnerType;
    directory?: string;
  }
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  const bundlePath =
    options.bundle ?? (target.endsWith(".mthds") ? target : undefined);

  if (!bundlePath) {
    agentError(
      "Provide a .mthds bundle file to validate (positional or --bundle).",
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  let mthdsContent: string;
  try {
    mthdsContent = readFileSync(bundlePath, "utf-8");
  } catch (err) {
    agentError(
      `Cannot read bundle: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
  }

  try {
    const result = await runner.validate({ mthds_content: mthdsContent });

    if (result.success) {
      agentSuccess({
        success: true,
        message: result.message,
        pipelex_bundle_blueprint: result.pipelex_bundle_blueprint,
      });
    } else {
      agentError(result.message, "ValidationError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
      });
    }
  } catch (err) {
    agentError((err as Error).message, "ValidationError", {
      error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
    });
  }
}
