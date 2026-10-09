import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { resolveRunBundle } from "../../runners/bundle.js";
import { isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { formatCliError } from "./error-output.js";
import { createRunner } from "../../runners/registry.js";
import type { PipelexRunFlags } from "../../runners/pipelex/runner.js";
import type { Runner, RunnerType } from "../../runners/types.js";
import type { StartOptions } from "../../protocol/options.js";

interface RunOptions {
  pipe?: string;
  inputs?: string;
  output?: string;
  prettyPrint?: boolean;
  dryRun?: boolean;
  mockInputs?: boolean;
  hosted?: boolean;
  local?: boolean;
  runner?: RunnerType;
  libraryDir?: string[];
}

function libraryDirs(options: RunOptions): string[] | undefined {
  return options.libraryDir?.length ? options.libraryDir : undefined;
}

/**
 * Read the pipelex run flags of `run pipe` and `run bundle`, refusing them on any
 * other runner before anything is read or started. Dropping them would turn a
 * requested dry run into a real, paid one: the API runner's `execute` has no dry run.
 */
function pipelexRunFlags(runner: Runner, cli: RunOptions): PipelexRunFlags {
  if (isPipelexRunner(runner)) {
    return {
      dryRun: cli.dryRun,
      mockInputs: cli.mockInputs,
      hosted: cli.hosted ? true : cli.local ? false : undefined,
    };
  }
  const named = [
    cli.dryRun && "--dry-run",
    cli.mockInputs && "--mock-inputs",
    cli.hosted && "--hosted",
    cli.local && "--local",
  ].filter((flag): flag is string => typeof flag === "string");
  if (named.length > 0) {
    const verb = named.length === 1 ? "applies" : "apply";
    let message = `${named.join(", ")} ${verb} only to the pipelex runner, and this run uses the ${runner.type} runner, so nothing was started.`;
    if (cli.dryRun || cli.mockInputs) {
      message +=
        " The API runner has no dry run: pass --runner pipelex to dry-run through pipelex, or check the bundle without running it with mthds validate bundle.";
    }
    p.log.error(message);
    p.outro("");
    process.exit(1);
  }
  return {};
}

/** Merge an optional JSON inputs file into the run options. */
function withInputs(options: StartOptions, inputsFile?: string): StartOptions {
  if (inputsFile) {
    options.inputs = JSON.parse(readFileSync(inputsFile, "utf-8")) as Record<string, unknown>;
  }
  return options;
}

/**
 * Run through the MTHDS Protocol `execute` primitive (blocking), dispatched on
 * the runner:
 *  - pipelex runner → the pipelex CLI on this machine, blocking — streams logs.
 *    pipelex executes the run locally or on the hosted Pipelex API, as its
 *    `[run] execution` setting says.
 *  - API runner     → blocking `POST /v1/execute`.
 *
 * `StartRequest = RunRequest`, so the same options object drives either path.
 * Both return a `DictRunResultExecute` carrying `pipe_output` — print that.
 */
async function dispatchRun(
  runner: Runner,
  options: StartOptions,
  flags: PipelexRunFlags,
  cli: RunOptions,
): Promise<void> {
  // Stopped with the failure marker before a failure prints, so the error neither
  // shares a line with a still-spinning frame nor follows a success marker.
  let spinner: ReturnType<typeof p.spinner> | undefined;
  try {
    let result;
    if (isPipelexRunner(runner)) {
      // The pipelex CLI streams its own logs to stderr — no spinner, or it
      // would fight the streamed output for the terminal.
      p.log.step(flags.dryRun ? "Dry-running via pipelex..." : "Executing via pipelex...");
      result = await runner.execute(options, flags);
    } else {
      spinner = p.spinner();
      spinner.start("Executing and waiting for result...");
      result = await runner.execute(options);
      spinner.stop("Run completed.");
      spinner = undefined;
    }

    if (cli.output) {
      writeFileSync(cli.output, JSON.stringify(result, null, 2) + "\n", "utf-8");
      p.log.success(`Output written to ${cli.output}`);
    }

    const output = result.pipe_output;
    if (cli.prettyPrint !== false && output) {
      p.log.info(JSON.stringify(output, null, 2));
    }

    p.outro("Done");
  } catch (err) {
    spinner?.error("Run failed.");
    p.log.error(formatCliError(err));
    p.outro("");
    process.exit(1);
  }
}

export async function runMethod(_name: string, options: RunOptions): Promise<void> {
  printLogo();
  p.intro("mthds run method");

  const runner = createRunner("mthds-cli", options.runner, libraryDirs(options));

  if (isPipelexRunner(runner)) {
    // `pipelex run method <name>` resolves an INSTALLED method by name (its
    // main pipe) — distinct from `run pipe <code>`. Collapsing it onto the
    // protocol `execute` (which only knows `pipe_code`) would emit
    // `pipelex run pipe <name>` and break methods whose name differs from
    // their main pipe code. Forward the method subcommand verbatim.
    p.log.step("Executing via pipelex...");
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

  // Running an installed method by name is a local-library concept; the API
  // runner has no name→method resolution (it addresses pipes/bundles).
  p.log.error(
    "Running an installed method by name is only supported by the pipelex runner.\n" +
      "With the API runner, use 'mthds run pipe <code>' or 'mthds run bundle <file>' (--runner pipelex to run a method by name).",
  );
  p.outro("");
  process.exit(1);
}

export async function runBundle(target: string, options: RunOptions): Promise<void> {
  printLogo();
  p.intro("mthds run bundle");

  const runner = createRunner("mthds-cli", options.runner, libraryDirs(options));
  const flags = pipelexRunFlags(runner, options);

  let runOptions: StartOptions;
  try {
    // A bundle target is a directory (or a `.mthds` with sibling `funcs/*.py`):
    // ship the whole method as `files` so custom PipeFunc Python travels with it.
    // A plain `.mthds` stays on the lighter `mthds_contents` path. `main` carries
    // the selected entrypoint through as `bundleMain` so a local runner points
    // `run bundle` at the named `.mthds`, never a sibling in the same directory.
    const resolved = resolveRunBundle(target);
    runOptions = {
      files: resolved.files,
      mthds_contents: resolved.mthds_contents,
      bundleMain: resolved.main,
    };
    if (options.pipe) {
      runOptions.pipe_code = options.pipe;
    }
    withInputs(runOptions, options.inputs);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  await dispatchRun(runner, runOptions, flags, options);
}

export async function runPipe(target: string, options: RunOptions): Promise<void> {
  printLogo();
  p.intro("mthds run pipe");

  const runner = createRunner("mthds-cli", options.runner, libraryDirs(options));
  const flags = pipelexRunFlags(runner, options);

  // A target is either a pipe code or a .mthds bundle file.
  const isBundlePath = target.endsWith(".mthds") || existsSync(target);

  let runOptions: StartOptions;
  try {
    if (isBundlePath) {
      runOptions = resolveRunBundle(target);
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

  await dispatchRun(runner, runOptions, flags, options);
}
