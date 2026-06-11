import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
import type { Runner, RunnerType } from "../../runners/types.js";
import type { StartOptions } from "../../protocol/options.js";

interface RunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  prettyPrint?: boolean;
  runner?: RunnerType;
  libraryDir?: string[];
}

function libraryDirs(options: RunOptions): string[] | undefined {
  return options.libraryDir?.length ? options.libraryDir : undefined;
}

/** Merge an optional JSON inputs file into the run options. */
function withInputs(options: StartOptions, inputsFile?: string): StartOptions {
  if (inputsFile) {
    options.inputs = JSON.parse(readFileSync(inputsFile, "utf-8")) as Record<
      string,
      unknown
    >;
  }
  return options;
}

/**
 * Run through the MTHDS Protocol primitives, dispatched on the runner:
 *  - pipelex runner → `execute` (local, blocking, in-process — streams logs).
 *  - API runner     → `startAndWaitForResult` (durable start, then poll to result).
 *
 * `StartRequest = RunRequest`, so the same options object drives either path.
 * `execute` returns `pipe_output`; `startAndWaitForResult` returns `main_stuff`
 * (with `pipe_output` as the bare-runner fallback) — print whichever is present.
 */
async function dispatchRun(
  runner: Runner,
  options: StartOptions,
  cli: RunOptions
): Promise<void> {
  try {
    let result;
    if (isPipelexRunner(runner)) {
      // The pipelex CLI streams its own logs to stderr — no spinner, or it
      // would fight the streamed output for the terminal.
      p.log.step("Executing via pipelex...");
      result = await runner.execute(options);
    } else {
      const s = p.spinner();
      s.start("Starting run and waiting for result...");
      result = await runner.startAndWaitForResult(options);
      s.stop("Run completed.");
    }

    if (cli.output) {
      writeFileSync(
        cli.output,
        JSON.stringify(result, null, 2) + "\n",
        "utf-8"
      );
      p.log.success(`Output written to ${cli.output}`);
    }

    const output =
      ("main_stuff" in result ? result.main_stuff : null) ?? result.pipe_output;
    if (cli.prettyPrint !== false && output) {
      p.log.info(JSON.stringify(output, null, 2));
    }

    p.outro("Done");
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

export async function runMethod(
  name: string,
  options: RunOptions
): Promise<void> {
  printLogo();
  p.intro("mthds run method");

  const runner = createRunner(options.runner, libraryDirs(options));

  let runOptions: StartOptions;
  try {
    // An installed method is addressed by its pipe code (the method name, or an
    // explicit `--pipe` override). The pipelex runner resolves it from its
    // library; the API runner resolves it server-side.
    runOptions = withInputs({ pipe_code: options.pipe ?? name }, options.inputs);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  await dispatchRun(runner, runOptions, options);
}

export async function runBundle(
  target: string,
  options: RunOptions
): Promise<void> {
  printLogo();
  p.intro("mthds run bundle");

  const runner = createRunner(options.runner, libraryDirs(options));

  let runOptions: StartOptions;
  try {
    runOptions = { mthds_contents: [readFileSync(resolve(target), "utf-8")] };
    if (options.pipe) {
      runOptions.pipe_code = options.pipe;
    }
    withInputs(runOptions, options.inputs);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  await dispatchRun(runner, runOptions, options);
}

export async function runPipe(
  target: string,
  options: RunOptions
): Promise<void> {
  printLogo();
  p.intro("mthds run pipe");

  const runner = createRunner(options.runner, libraryDirs(options));

  // A target is either a pipe code or a .mthds bundle file.
  const isBundlePath = target.endsWith(".mthds") || existsSync(target);

  let runOptions: StartOptions;
  try {
    if (isBundlePath) {
      runOptions = { mthds_contents: [readFileSync(resolve(target), "utf-8")] };
      if (options.pipe) {
        runOptions.pipe_code = options.pipe;
      }
    } else {
      runOptions = { pipe_code: target };
    }
    withInputs(runOptions, options.inputs);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  await dispatchRun(runner, runOptions, options);
}
