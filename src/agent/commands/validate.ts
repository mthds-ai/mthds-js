/**
 * Agent validate command — validates a .mthds bundle and outputs JSON.
 */

import { readFileSync } from "node:fs";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import { isPipelexRunner } from "../../cli/commands/utils.js";
import type { RunnerType } from "../../runners/types.js";

/** Extract raw args after `validate`, filtering out --runner, -L/--library-dir, and --log-level */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const idx = argv.indexOf("validate");
  if (idx === -1) return [];
  const raw = argv.slice(idx + 1);
  const result: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (
      raw[i] === "--runner" ||
      raw[i] === "-L" ||
      raw[i] === "--library-dir" ||
      raw[i] === "--log-level"
    ) {
      i += 2;
    } else if (
      raw[i]!.startsWith("--runner=") ||
      raw[i]!.startsWith("--library-dir=") ||
      raw[i]!.startsWith("--log-level=")
    ) {
      i += 1;
    } else {
      result.push(raw[i]!);
      i++;
    }
  }
  return result;
}

export async function agentValidateMethod(
  name: string,
  options: {
    pipe?: string;
    runner?: RunnerType;
    libraryDir?: string[];
  }
): Promise<void> {
  const libraryDirs = options.libraryDir?.length
    ? options.libraryDir
    : undefined;

  let runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.validatePassthrough(extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "ValidationError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
      });
    }
    return;
  }

  agentError(
    "Method target is not yet supported for the API runner. Use 'mthds-agent validate pipe <target>' instead, or specify a different runner with --runner <name>.",
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
  );
}

export async function agentValidatePipe(
  target: string,
  options: {
    pipe?: string;
    bundle?: string;
    runner?: RunnerType;
    libraryDir?: string[];
  }
): Promise<void> {
  const libraryDirs = options.libraryDir?.length
    ? options.libraryDir
    : undefined;

  let runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.validatePassthrough(extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "ValidationError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
      });
    }
    return;
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
