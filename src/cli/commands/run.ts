import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../../runners/registry.js";
import type { Runner, RunnerType } from "../../runners/types.js";
import type { ExecutePipelineOptions } from "../../client/pipeline.js";

function isStreamingRunner(runner: Runner): boolean {
  return runner.type === "pipelex";
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
  const packageDir = options.directory ? resolve(options.directory) : process.cwd();
  const resolvedTarget = target.startsWith("/") ? target : resolve(packageDir, target);
  const isBundle = resolvedTarget.endsWith(".plx");

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

  const streaming = isStreamingRunner(runner);
  const s = streaming ? null : p.spinner();
  s?.start("Executing pipeline...");
  if (streaming) p.log.step("Executing pipeline...");

  try {
    const result = await runner.executePipeline(pipelineOptions);
    s?.stop(`Pipeline ${result.pipeline_state.toLowerCase()}.`);
    if (streaming) p.log.success(`Pipeline ${result.pipeline_state.toLowerCase()}.`);

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
    s?.stop("Pipeline execution failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
