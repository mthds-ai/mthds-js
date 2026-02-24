import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../../runners/registry.js";
import { PipelexRunner } from "../../runners/pipelex-runner.js";
import { Runners } from "../../runners/types.js";
import type { ConceptRepresentationFormat, Runner, RunnerType } from "../../runners/types.js";

interface WithRunner {
  runner?: RunnerType;
  directory?: string;
}

function isStreamingRunner(runner: Runner): boolean {
  return runner.type === Runners.PIPELEX;
}

function isPipelexRunner(runner: Runner): runner is PipelexRunner {
  return runner.type === Runners.PIPELEX;
}

/** Extract raw args after `build <subcommand>`, filtering out --runner and -d/--directory */
function extractPassthroughArgs(): string[] {
  const argv = process.argv;
  const buildIdx = argv.indexOf("build");
  if (buildIdx === -1) return [];
  const raw = argv.slice(buildIdx + 2); // skip "build" + subcommand
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
      await runner.buildPassthrough("pipe", extractPassthroughArgs());
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

// ── mthds build runner <target> [--pipe code] [-o file] ─────────────

export async function buildRunner(
  target: string,
  options: { pipe?: string; output?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build runner");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs());
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

// ── mthds build inputs <bundle.mthds> --pipe <code> ─────────────────

export async function buildInputs(
  target: string,
  options: { pipe?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs());
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

// ── mthds build output <bundle.mthds> --pipe <code> [--format] ──────

export async function buildOutput(
  target: string,
  options: { pipe?: string; format?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build output");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs());
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
