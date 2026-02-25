/**
 * Agent run command — executes a pipeline and outputs JSON.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import { isPipelexRunner } from "../../cli/commands/utils.js";
import type { Runner, RunnerType } from "../../runners/types.js";
import type { ExecutePipelineOptions } from "../../client/pipeline.js";

/** Extract raw args after `run`, filtering out --runner, -d/--directory, and --log-level */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const runIdx = argv.indexOf("run");
  if (runIdx === -1) return [];
  const raw = argv.slice(runIdx + 1);
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

interface AgentRunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  runner?: RunnerType;
  directory?: string;
}

export async function agentRunMethod(
  name: string,
  options: AgentRunOptions
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError(
      (err as Error).message,
      "RunnerError",
      { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
    );
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.runPassthrough(extractPassthroughArgs());
    } catch (err) {
      agentError(
        (err as Error).message,
        "PipelineError",
        { error_domain: AGENT_ERROR_DOMAINS.PIPELINE }
      );
    }
    return;
  }

  agentError(
    "Method target is not yet supported for the API runner. Use 'mthds-agent run pipe <target>' instead.",
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
  );
}

export async function agentRunPipe(
  target: string,
  options: AgentRunOptions
): Promise<void> {
  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;

  let runner: Runner;
  try {
    runner = createRunner(options.runner, libraryDirs);
  } catch (err) {
    agentError(
      (err as Error).message,
      "RunnerError",
      { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
    );
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.runPassthrough(extractPassthroughArgs());
    } catch (err) {
      agentError(
        (err as Error).message,
        "PipelineError",
        { error_domain: AGENT_ERROR_DOMAINS.PIPELINE }
      );
    }
    return;
  }

  // API runner path
  const packageDir = options.directory
    ? resolve(options.directory)
    : process.cwd();
  const resolvedTarget = target.startsWith("/")
    ? target
    : resolve(packageDir, target);
  const isBundle = resolvedTarget.endsWith(".mthds");

  const pipelineOptions: ExecutePipelineOptions = {};

  if (isBundle) {
    try {
      pipelineOptions.mthds_content = readFileSync(resolvedTarget, "utf-8");
    } catch (err) {
      agentError(
        `Cannot read bundle: ${(err as Error).message}`,
        "IOError",
        { error_domain: AGENT_ERROR_DOMAINS.IO }
      );
    }
    if (options.pipe) {
      pipelineOptions.pipe_code = options.pipe;
    }
  } else {
    pipelineOptions.pipe_code = target;
  }

  if (options.inputs) {
    try {
      pipelineOptions.inputs = JSON.parse(
        readFileSync(options.inputs, "utf-8")
      );
    } catch (err) {
      agentError(
        `Cannot read inputs: ${(err as Error).message}`,
        "IOError",
        { error_domain: AGENT_ERROR_DOMAINS.IO }
      );
    }
  }

  try {
    const result = await runner.executePipeline(pipelineOptions);

    if (options.output) {
      writeFileSync(
        options.output,
        JSON.stringify(result, null, 2) + "\n",
        "utf-8"
      );
    }

    agentSuccess({
      success: true,
      pipeline_run_id: result.pipeline_run_id,
      pipeline_state: result.pipeline_state,
      pipe_output: result.pipe_output ?? null,
      main_stuff_name: result.main_stuff_name ?? null,
    });
  } catch (err) {
    agentError(
      (err as Error).message,
      "PipelineError",
      { error_domain: AGENT_ERROR_DOMAINS.PIPELINE }
    );
  }
}
