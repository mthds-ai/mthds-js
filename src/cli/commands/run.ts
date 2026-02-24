import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../../runners/registry.js";
import { PipelexRunner } from "../../runners/pipelex-runner.js";
import { Runners } from "../../runners/types.js";
import type { Runner, RunnerType } from "../../runners/types.js";
import type { ExecutePipelineOptions } from "../../client/pipeline.js";

function isPipelexRunner(runner: Runner): runner is PipelexRunner {
  return runner.type === Runners.PIPELEX;
}

/** Extract raw args after `run`, filtering out --runner and -d/--directory */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const runIdx = argv.indexOf("run");
  if (runIdx === -1) return [];
  const raw = argv.slice(runIdx + 1);
  const result: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "--runner" || raw[i] === "-d" || raw[i] === "--directory") {
      i += 2;
    } else {
      result.push(raw[i]!);
      i++;
    }
  }
  return result;
}

interface RunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  noOutput?: boolean;
  noPrettyPrint?: boolean;
  runner?: RunnerType;
  directory?: string;
}

export async function runPipeline(
  target: string,
  options: RunOptions
): Promise<void> {
  printLogo();
  p.intro("mthds run");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Running via pipelex...");
    try {
      await runner.runPassthrough(extractPassthroughArgs());
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  const packageDir = options.directory ? resolve(options.directory) : process.cwd();
  const resolvedTarget = target.startsWith("/") ? target : resolve(packageDir, target);
  const isBundle = resolvedTarget.endsWith(".mthds");

  const pipelineOptions: ExecutePipelineOptions = {};

  if (isBundle) {
    pipelineOptions.mthds_content = readFileSync(resolvedTarget, "utf-8");
    if (options.pipe) {
      pipelineOptions.pipe_code = options.pipe;
    }
  } else {
    pipelineOptions.pipe_code = target;
  }

  if (options.inputs) {
    pipelineOptions.inputs = JSON.parse(readFileSync(options.inputs, "utf-8"));
  }

  const s = p.spinner();
  s.start("Executing pipeline...");

  try {
    const result = await runner.executePipeline(pipelineOptions);
    s.stop(`Pipeline ${result.pipeline_state.toLowerCase()}.`);

    if (!options.noOutput && options.output) {
      writeFileSync(
        options.output,
        JSON.stringify(result, null, 2) + "\n",
        "utf-8"
      );
      p.log.success(`Output written to ${options.output}`);
    }

    if (!options.noPrettyPrint && result.pipe_output) {
      p.log.info(JSON.stringify(result.pipe_output, null, 2));
    }

    p.outro("Done");
  } catch (err) {
    s.stop("Pipeline execution failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
