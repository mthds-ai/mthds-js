import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
import type { RunnerType } from "../../runners/types.js";
import type { ExecutePipelineOptions } from "../../client/pipeline.js";

interface RunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  prettyPrint?: boolean;
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
      await runner.runPassthrough(extractPassthroughArgs("run", 1));
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

  try {
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
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Executing pipeline...");

  try {
    const result = await runner.executePipeline(pipelineOptions);
    s.stop(`Pipeline ${result.pipeline_state.toLowerCase()}.`);

    if (options.output) {
      writeFileSync(
        options.output,
        JSON.stringify(result, null, 2) + "\n",
        "utf-8"
      );
      p.log.success(`Output written to ${options.output}`);
    }

    if (options.prettyPrint !== false && result.pipe_output) {
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
