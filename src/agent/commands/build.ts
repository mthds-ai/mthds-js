/**
 * Agent build subcommands — generate pipelines, runner code, inputs, and output schemas.
 * Outputs JSON only.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import { isPipelexRunner } from "../../cli/commands/utils.js";
import type { ConceptRepresentationFormat, Runner, RunnerType } from "../../runners/types.js";

interface WithRunner {
  runner?: RunnerType;
  directory?: string;
}

/** Extract raw args after `build <subcommand>`, filtering out --runner, -d/--directory, and --log-level */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const buildIdx = argv.indexOf("build");
  if (buildIdx === -1) return [];
  const raw = argv.slice(buildIdx + 2); // skip "build" + subcommand
  const result: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (
      raw[i] === "--runner" ||
      raw[i] === "-d" ||
      raw[i] === "--directory" ||
      raw[i] === "--log-level"
    ) {
      i += 2; // skip flag + value
    } else if (
      raw[i]!.startsWith("--runner=") ||
      raw[i]!.startsWith("--directory=") ||
      raw[i]!.startsWith("--log-level=")
    ) {
      i += 1; // skip combined flag=value
    } else {
      result.push(raw[i]!);
      i++;
    }
  }
  return result;
}

// ── build pipe ────────────────────────────────────────────────────────

export async function agentBuildPipe(
  brief: string,
  options: { output?: string } & WithRunner
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.buildPassthrough("pipe", extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "RunnerError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    }
    return;
  }

  try {
    const result = await runner.buildPipe({ brief, output: options.output });

    if (result.mthds_content && options.output) {
      writeFileSync(options.output, result.mthds_content, "utf-8");
    }

    agentSuccess({
      success: result.success,
      message: result.message,
      mthds_content: result.mthds_content,
      pipelex_bundle_blueprint: result.pipelex_bundle_blueprint,
    });
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
}

// ── build runner ──────────────────────────────────────────────────────

export async function agentBuildRunner(
  target: string,
  options: { pipe?: string; output?: string } & WithRunner
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "RunnerError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    }
    return;
  }

  if (!target.endsWith(".mthds")) {
    agentError(
      "build runner requires a .mthds bundle file as the target.",
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  if (!options.pipe) {
    agentError("--pipe is required when using the API runner.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  let mthdsContent: string;
  try {
    mthdsContent = readFileSync(target, "utf-8");
  } catch (err) {
    agentError(
      `Cannot read bundle: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
  }

  try {
    const result = await runner.buildRunner({
      mthds_content: mthdsContent,
      pipe_code: options.pipe,
    });

    if (options.output) {
      writeFileSync(options.output, result.python_code, "utf-8");
    }

    agentSuccess({
      success: result.success,
      message: result.message,
      python_code: result.python_code,
      pipe_code: result.pipe_code,
    });
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
}

// ── build inputs ──────────────────────────────────────────────────────

export async function agentBuildInputs(
  target: string,
  options: { pipe?: string } & WithRunner
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "RunnerError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    }
    return;
  }

  if (!options.pipe) {
    agentError("--pipe is required when using the API runner.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  let mthdsContent: string;
  try {
    mthdsContent = readFileSync(target, "utf-8");
  } catch (err) {
    agentError(
      `Cannot read bundle: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
  }

  try {
    const result = await runner.buildInputs({
      mthds_content: mthdsContent,
      pipe_code: options.pipe,
    });

    agentSuccess({
      success: true,
      inputs: result,
    });
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
}

// ── build output ──────────────────────────────────────────────────────

export async function agentBuildOutput(
  target: string,
  options: { pipe?: string; format?: string } & WithRunner
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs());
    } catch (err) {
      agentError((err as Error).message, "RunnerError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    }
    return;
  }

  if (!options.pipe) {
    agentError("--pipe is required when using the API runner.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  let mthdsContent: string;
  try {
    mthdsContent = readFileSync(target, "utf-8");
  } catch (err) {
    agentError(
      `Cannot read bundle: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
  }

  try {
    const result = await runner.buildOutput({
      mthds_content: mthdsContent,
      pipe_code: options.pipe,
      format: (options.format as ConceptRepresentationFormat) ?? "schema",
    });

    agentSuccess({
      success: true,
      output: result,
    });
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
}
