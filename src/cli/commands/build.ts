import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
import type { ConceptRepresentationFormat, RunnerType } from "../../runners/types.js";

interface WithRunner {
  runner?: RunnerType;
  directory?: string;
}

// ── mthds build pipe "PROMPT" [-o file] ─────────────────────────────

export async function buildPipe(
  brief: string,
  options: { output?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build pipe");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("pipe", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  const s = p.spinner();
  s.start("Building pipeline...");

  try {
    const result = await runner.buildPipe({
      brief,
      output: options.output,
    });
    s.stop(result.message);

    if (result.mthds_content) {
      if (options.output) {
        writeFileSync(options.output, result.mthds_content, "utf-8");
        p.log.success(`Bundle written to ${options.output}`);
      } else {
        p.log.info(result.mthds_content);
      }
    }

    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build runner method <name> ─────────────────────────────────

export async function buildRunnerMethod(
  name: string,
  options: { pipe?: string; output?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build runner method");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error("Method target is not yet supported for the API runner. Use 'mthds build runner pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds set-default runner <name>'.");
  p.outro("");
  process.exit(1);
}

// ── mthds build runner pipe <target> ─────────────────────────────────

export async function buildRunnerPipe(
  target: string,
  options: { pipe?: string; output?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build runner pipe");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  const isBundle = target.endsWith(".mthds");

  let mthdsContent: string;
  let pipeCode: string;

  if (isBundle) {
    mthdsContent = readFileSync(target, "utf-8");
    if (!options.pipe) {
      p.log.error("--pipe is required when using the API runner.");
      p.outro("");
      process.exit(1);
    }
    pipeCode = options.pipe;
  } else {
    p.log.error(
      "build runner requires a .mthds bundle file. Pass the bundle path as the target."
    );
    p.outro("");
    process.exit(1);
    return; // unreachable, keeps TS happy
  }

  const s = p.spinner();
  s.start("Generating runner code...");

  try {
    const result = await runner.buildRunner({
      mthds_content: mthdsContent,
      pipe_code: pipeCode,
    });
    s.stop(result.message);

    if (options.output) {
      writeFileSync(options.output, result.python_code, "utf-8");
      p.log.success(`Runner written to ${options.output}`);
    } else {
      p.log.info(result.python_code);
    }

    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build inputs method <name> ─────────────────────────────────

export async function buildInputsMethod(
  name: string,
  options: { pipe?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs method");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error("Method target is not yet supported for the API runner. Use 'mthds build inputs pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds set-default runner <name>'.");
  p.outro("");
  process.exit(1);
}

// ── mthds build inputs pipe <target> ─────────────────────────────────

export async function buildInputsPipe(
  target: string,
  options: { pipe?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs pipe");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  if (!options.pipe) {
    p.log.error("--pipe is required when using the API runner.");
    p.outro("");
    process.exit(1);
  }

  const mthdsContent = readFileSync(target, "utf-8");

  const s = p.spinner();
  s.start("Generating example inputs...");

  try {
    const result = await runner.buildInputs({
      mthds_content: mthdsContent,
      pipe_code: options.pipe,
    });
    s.stop("Inputs generated.");
    p.log.info(JSON.stringify(result, null, 2));
    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build output method <name> ─────────────────────────────────

export async function buildOutputMethod(
  name: string,
  options: { pipe?: string; format?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build output method");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error("Method target is not yet supported for the API runner. Use 'mthds build output pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds set-default runner <name>'.");
  p.outro("");
  process.exit(1);
}

// ── mthds build output pipe <target> ─────────────────────────────────

export async function buildOutputPipe(
  target: string,
  options: { pipe?: string; format?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build output pipe");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  if (!options.pipe) {
    p.log.error("--pipe is required when using the API runner.");
    p.outro("");
    process.exit(1);
  }

  const mthdsContent = readFileSync(target, "utf-8");

  const s = p.spinner();
  s.start("Generating output schema...");

  try {
    const result = await runner.buildOutput({
      mthds_content: mthdsContent,
      pipe_code: options.pipe,
      format: (options.format as ConceptRepresentationFormat) ?? "schema",
    });
    s.stop("Output generated.");
    p.log.info(JSON.stringify(result, null, 2));
    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
