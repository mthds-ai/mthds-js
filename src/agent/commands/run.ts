/**
 * Agent run command — runs a method, pipe, or bundle and outputs JSON.
 */

import { agentError, agentProblem, problemOfError, unexpectedProblem } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import { isPipelexRunner } from "../../cli/commands/utils.js";
import type { RunnerType } from "../../runners/types.js";

/** Extract raw args after `run`, filtering out --runner, -L/--library-dir, and --log-level */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const idx = argv.indexOf("run");
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

interface AgentRunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  prettyPrint?: boolean;
  runner?: RunnerType;
  libraryDir?: string[];
}

async function agentRunTarget(options: AgentRunOptions, fallbackMsg: string): Promise<void> {
  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;

  let runner;
  try {
    runner = createRunner("mthds-agent", options.runner, libraryDirs);
  } catch (err) {
    agentError(
      problemOfError(err, (message) =>
        agentProblem("client.not_configured", { setting: "runner" }, message),
      ),
    );
  }

  if (isPipelexRunner(runner)) {
    try {
      await runner.runPassthrough(extractPassthroughArgs());
    } catch (err) {
      agentError(problemOfError(err, unexpectedProblem));
    }
    return;
  }

  agentError(
    agentProblem(
      "client.argument_invalid",
      { argument: "target", reason: "unsupported" },
      fallbackMsg,
    ),
  );
}

export async function agentRunMethod(_name: string, options: AgentRunOptions): Promise<void> {
  return agentRunTarget(
    options,
    "Method target is not yet supported for the API runner. Use 'mthds-agent run pipe <target>' instead, or specify a different runner with --runner <name>.",
  );
}

export async function agentRunPipe(_target: string, options: AgentRunOptions): Promise<void> {
  return agentRunTarget(
    options,
    "Pipe target is not yet supported for the API runner via mthds-agent. Use the pipelex runner with --runner pipelex.",
  );
}

export async function agentRunBundle(_target: string, options: AgentRunOptions): Promise<void> {
  return agentRunTarget(
    options,
    "Bundle target is only supported with the pipelex runner. Specify --runner pipelex.",
  );
}
