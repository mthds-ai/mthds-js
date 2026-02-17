import { readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../runners/registry.js";
import type { ExecuteRequest, RunnerType } from "../runners/types.js";

interface RunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  noOutput?: boolean;
  noPrettyPrint?: boolean;
  runner?: RunnerType;
}

export async function runPipeline(
  target: string,
  options: RunOptions
): Promise<void> {
  printLogo();
  p.intro("mthds run");

  const runner = createRunner(options.runner);
  const isBundle = target.endsWith(".plx");

  const request: ExecuteRequest = {};

  if (isBundle) {
    request.plx_content = readFileSync(target, "utf-8");
    if (options.pipe) {
      request.pipe_code = options.pipe;
    }
  } else {
    request.pipe_code = target;
  }

  if (options.inputs) {
    request.inputs = JSON.parse(readFileSync(options.inputs, "utf-8"));
  }

  const s = p.spinner();
  s.start("Executing pipeline...");

  try {
    const result = await runner.execute(request);
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
