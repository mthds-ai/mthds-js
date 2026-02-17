#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import * as p from "@clack/prompts";
import { showBanner } from "./commands/index.js";
import { printLogo } from "./commands/index.js";
import { installRunner } from "./commands/setup.js";
import { installMethod } from "./commands/install.js";
import { configSet, configGet, configList } from "./commands/config.js";
import { runPipeline } from "./commands/run.js";
import {
  buildPipe,
  buildRunner,
  buildInputs,
  buildOutput,
} from "./commands/build.js";
import { validatePlx } from "./commands/validate.js";
import { runnerSetDefault, runnerList } from "./commands/runner.js";
import type { RunnerType } from "./runners/types.js";
import type { Command as Cmd } from "commander";

function getRunner(cmd: Cmd): RunnerType | undefined {
  return cmd.optsWithGlobals().runner as RunnerType | undefined;
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("mthds")
  .version(pkg.version)
  .description("CLI bridge to the Pipelex runtime")
  .option("--runner <type>", "Runner to use (api, pipelex)")
  .exitOverride()
  .configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

// ── mthds run <target> ─────────────────────────────────────────────
program
  .command("run")
  .argument("<target>", "Pipe code or .plx bundle file")
  .option("--pipe <code>", "Pipe code (when target is a bundle)")
  .option("-i, --inputs <file>", "Path to JSON inputs file")
  .option("-o, --output <file>", "Path to save output JSON")
  .option("--no-output", "Skip saving output to file")
  .option("--no-pretty-print", "Skip pretty printing the output")
  .description("Execute a pipeline")
  .exitOverride()
  .action(async (target: string, options: Record<string, string | boolean | undefined>, cmd: Cmd) => {
    await runPipeline(target, { ...options, runner: getRunner(cmd) } as Parameters<typeof runPipeline>[1]);
  });

// ── mthds build <subcommand> ────────────────────────────────────────
const build = program
  .command("build")
  .description("Generate pipelines, runner code, inputs, and output schemas")
  .exitOverride();

build
  .command("pipe")
  .argument("<brief>", "Natural-language description of the pipeline")
  .option("-o, --output <file>", "Path to save the generated .plx file")
  .description("Build a pipeline from a prompt")
  .exitOverride()
  .action(async (brief: string, options: { output?: string }, cmd: Cmd) => {
    await buildPipe(brief, { ...options, runner: getRunner(cmd) });
  });

build
  .command("runner")
  .argument("<target>", ".plx bundle file")
  .option("--pipe <code>", "Pipe code to generate runner for")
  .option("-o, --output <file>", "Path to save the generated Python file")
  .description("Generate Python runner code for a pipe")
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; output?: string }, cmd: Cmd) => {
    await buildRunner(target, { ...options, runner: getRunner(cmd) });
  });

build
  .command("inputs")
  .argument("<target>", ".plx bundle file")
  .requiredOption("--pipe <code>", "Pipe code to generate inputs for")
  .description("Generate example input JSON for a pipe")
  .exitOverride()
  .action(async (target: string, options: { pipe: string }, cmd: Cmd) => {
    await buildInputs(target, { ...options, runner: getRunner(cmd) });
  });

build
  .command("output")
  .argument("<target>", ".plx bundle file")
  .requiredOption("--pipe <code>", "Pipe code to generate output for")
  .option("--format <format>", "Output format (json, python, schema)", "schema")
  .description("Generate output representation for a pipe")
  .exitOverride()
  .action(async (target: string, options: { pipe: string; format?: string }, cmd: Cmd) => {
    await buildOutput(target, { ...options, runner: getRunner(cmd) });
  });

// ── mthds validate <target> ────────────────────────────────────────
program
  .command("validate")
  .argument("<target>", ".plx bundle file or pipe code")
  .option("--pipe <code>", "Pipe code that must exist in the bundle")
  .option("--bundle <file>", "Bundle file path (alternative to positional)")
  .description("Validate PLX content")
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; bundle?: string }, cmd: Cmd) => {
    await validatePlx(target, { ...options, runner: getRunner(cmd) });
  });

// ── mthds install <slug> ───────────────────────────────────────────
program
  .command("install")
  .argument("<slug>", "Method slug to install")
  .description("Install a method")
  .exitOverride()
  .action(async (slug: string) => {
    await installMethod(slug);
  });

// ── mthds setup runner <name> ──────────────────────────────────────
const setup = program.command("setup").exitOverride();

setup
  .command("runner <name>")
  .description("Install a runner (e.g. pipelex)")
  .exitOverride()
  .action(async (name: string) => {
    await installRunner(name);
  });

// ── mthds runner set-default|list ───────────────────────────────────
const runnerCmd = program
  .command("runner")
  .description("Manage runners")
  .exitOverride();

runnerCmd
  .command("set-default")
  .argument("<name>", "Runner name (api, pipelex)")
  .description("Set the default runner")
  .exitOverride()
  .action(async (name: string) => {
    await runnerSetDefault(name);
  });

runnerCmd
  .command("list")
  .description("List available runners")
  .exitOverride()
  .action(async () => {
    await runnerList();
  });

// ── mthds config set|get|list ──────────────────────────────────────
const config = program.command("config").description("Manage configuration").exitOverride();

config
  .command("set")
  .argument("<key>", "Config key (runner, api-url, api-key)")
  .argument("<value>", "Value to set")
  .description("Set a config value")
  .exitOverride()
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

config
  .command("get")
  .argument("<key>", "Config key (runner, api-url, api-key)")
  .description("Get a config value")
  .exitOverride()
  .action(async (key: string) => {
    await configGet(key);
  });

config
  .command("list")
  .description("List all config values")
  .exitOverride()
  .action(async () => {
    await configList();
  });

// Default: show banner
program.action(() => {
  showBanner();
});

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // --help and --version exit with code 0
    if (err.exitCode === 0) {
      process.exit(0);
    }

    printLogo();
    p.intro("mthds");

    const message = err.message
      .replace(/^error: /, "")
      .replace(/^Error: /, "");

    p.log.error(message);

    if (err.code === "commander.missingArgument") {
      const args = process.argv.slice(2);
      if (args.includes("runner") && args.includes("set-default")) {
        p.log.info("Run mthds runner list to see available runners.");
      } else {
        p.log.info("Run mthds --help to see usage.");
      }
    }

    p.outro("");
    process.exit(1);
  }

  printLogo();
  p.intro("mthds");
  p.log.error((err as Error).message);
  p.outro("");
  process.exit(1);
});
