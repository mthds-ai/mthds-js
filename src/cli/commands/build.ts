import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../../runners/registry.js";
import type { ConceptRepresentationFormat, Runner, RunnerType } from "../../runners/types.js";

interface WithRunner {
  runner?: RunnerType;
  directory?: string;
}

function isStreamingRunner(runner: Runner): boolean {
  return runner.type === "pipelex";
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
  const streaming = isStreamingRunner(runner);
  const s = streaming ? null : p.spinner();
  s?.start("Building pipeline...");
  if (streaming) p.log.step("Building pipeline...");

  try {
    const result = await runner.buildPipe({
      brief,
      output: options.output,
    });
    s?.stop(result.message);
    if (streaming) p.log.success(result.message);

    if (result.plx_content) {
      if (options.output) {
        writeFileSync(options.output, result.plx_content, "utf-8");
        p.log.success(`PLX written to ${options.output}`);
      } else {
        p.log.info(result.plx_content);
      }
    }

    p.outro("Done");
  } catch (err) {
    s?.stop("Build failed.");
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
  const isBundle = target.endsWith(".plx");

  let plxContent: string;
  let pipeCode: string;

  if (isBundle) {
    plxContent = readFileSync(target, "utf-8");
    if (!options.pipe) {
      p.log.error("--pipe is required when passing a .plx bundle.");
      p.outro("");
      process.exit(1);
    }
    pipeCode = options.pipe;
  } else {
    // target is a pipe code — we still need plx content
    p.log.error(
      "build runner requires a .plx bundle file. Pass the bundle path as the target."
    );
    p.outro("");
    process.exit(1);
    return; // unreachable, keeps TS happy
  }

  const streaming = isStreamingRunner(runner);
  const s = streaming ? null : p.spinner();
  s?.start("Generating runner code...");
  if (streaming) p.log.step("Generating runner code...");

  try {
    const result = await runner.buildRunner({
      plx_content: plxContent,
      pipe_code: pipeCode,
    });
    s?.stop(result.message);
    if (streaming) p.log.success(result.message);

    if (options.output) {
      writeFileSync(options.output, result.python_code, "utf-8");
      p.log.success(`Runner written to ${options.output}`);
    } else {
      p.log.info(result.python_code);
    }

    p.outro("Done");
  } catch (err) {
    s?.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build inputs <bundle.plx> --pipe <code> ───────────────────

export async function buildInputs(
  target: string,
  options: { pipe: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);
  const plxContent = readFileSync(target, "utf-8");

  const s = p.spinner();
  s.start("Generating example inputs...");

  try {
    const result = await runner.buildInputs({
      plx_content: plxContent,
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

// ── mthds build output <bundle.plx> --pipe <code> [--format] ────────

export async function buildOutput(
  target: string,
  options: { pipe: string; format?: string } & WithRunner
): Promise<void> {
  printLogo();
  p.intro("mthds build output");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);
  const plxContent = readFileSync(target, "utf-8");

  const s = p.spinner();
  s.start("Generating output schema...");

  try {
    const result = await runner.buildOutput({
      plx_content: plxContent,
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
