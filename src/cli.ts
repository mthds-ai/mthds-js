#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import * as p from "@clack/prompts";
import { showBanner } from "./cli/commands/index.js";
import { printLogo } from "./cli/commands/index.js";
import { installRunner } from "./cli/commands/setup.js";
import { installMethod } from "./cli/commands/install.js";
import { configSet, configGet, configList } from "./cli/commands/config.js";
import { runPipeline } from "./cli/commands/run.js";
import {
  buildPipe,
  buildRunner,
  buildInputs,
  buildOutput,
} from "./cli/commands/build.js";
import { validateBundle } from "./cli/commands/validate.js";
import {
  packageInit,
  packageList,
  packageAdd,
  packageLock,
  packageInstall,
  packageUpdate,
} from "./cli/commands/package/stubs.js";
import { RUNNER_NAMES } from "./runners/types.js";
import type { RunnerType } from "./runners/types.js";
import type { Command as Cmd } from "commander";

function getRunner(cmd: Cmd): RunnerType | undefined {
  return cmd.optsWithGlobals().runner as RunnerType | undefined;
}

function getDirectory(cmd: Cmd): string | undefined {
  return cmd.optsWithGlobals().directory as string | undefined;
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("mthds")
  .version(pkg.version)
  .description("CLI for the MTHDS open standard")
  .option("--runner <type>", `Runner to use (${RUNNER_NAMES.join(", ")})`)
  .option("-d, --directory <path>", "Target package directory (defaults to current directory)")
  .exitOverride()
  .configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

// ── mthds run <target> ─────────────────────────────────────────────
program
  .command("run")
  .argument("<target>", "Pipe code or .mthds bundle file")
  .option("--pipe <code>", "Pipe code (when target is a bundle)")
  .option("-i, --inputs <file>", "Path to JSON inputs file")
  .option("-o, --output <file>", "Path to save output JSON")
  .option("--no-output", "Skip saving output to file")
  .option("--no-pretty-print", "Skip pretty printing the output")
  .description("Execute a pipeline")
  .allowUnknownOption()
  .exitOverride()
  .action(async (target: string, options: Record<string, string | boolean | undefined>, cmd: Cmd) => {
    await runPipeline(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) } as Parameters<typeof runPipeline>[1]);
  });

// ── mthds build <subcommand> ────────────────────────────────────────
const build = program
  .command("build")
  .description("Generate pipelines, runner code, inputs, and output schemas")
  .exitOverride();

build
  .command("pipe")
  .argument("<brief>", "Natural-language description of the pipeline")
  .option("-o, --output <file>", "Path to save the generated .mthds file")
  .description("Build a pipeline from a prompt")
  .allowUnknownOption()
  .exitOverride()
  .action(async (brief: string, options: { output?: string }, cmd: Cmd) => {
    await buildPipe(brief, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("runner")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate runner for")
  .option("-o, --output <file>", "Path to save the generated Python file")
  .description("Generate Python runner code for a pipe")
  .allowUnknownOption()
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; output?: string }, cmd: Cmd) => {
    await buildRunner(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("inputs")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate inputs for")
  .description("Generate example input JSON for a pipe")
  .allowUnknownOption()
  .exitOverride()
  .action(async (target: string, options: { pipe?: string }, cmd: Cmd) => {
    await buildInputs(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("output")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate output for")
  .option("--format <format>", "Output format (json, python, schema)", "schema")
  .description("Generate output representation for a pipe")
  .allowUnknownOption()
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; format?: string }, cmd: Cmd) => {
    await buildOutput(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

// ── mthds validate <target> ────────────────────────────────────────
program
  .command("validate")
  .argument("<target>", ".mthds bundle file or pipe code")
  .option("--pipe <code>", "Pipe code that must exist in the bundle")
  .option("--bundle <file>", "Bundle file path (alternative to positional)")
  .description("Validate a bundle")
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; bundle?: string }, cmd: Cmd) => {
    await validateBundle(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

// ── mthds install [address] (JS-only) ──────────────────────────────
program
  .command("install")
  .argument("[address]", "Package address (org/repo or org/repo/sub/path)")
  .option("--local <path>", "Install from a local directory")
  .option("--method <slug>", "Install only the specified method (by slug)")
  .description("Install a method package")
  .exitOverride()
  .action(async (address: string | undefined, opts: { local?: string; method?: string }) => {
    if (address && opts.local) {
      printLogo();
      p.intro("mthds install");
      p.log.error("Cannot use both an address and --local at the same time.");
      p.outro("");
      process.exit(1);
    }
    if (!address && !opts.local) {
      printLogo();
      p.intro("mthds install");
      p.log.error("Provide an address (org/repo) or use --local <path>.");
      p.outro("");
      process.exit(1);
    }
    await installMethod({ address, dir: opts.local, method: opts.method });
  });

// ── mthds config set|get|list ──────────────────────────────────────
const config = program.command("config").description("Manage configuration").exitOverride();

config
  .command("set")
  .argument("<key>", "Config key (runner, api-url, api-key, telemetry)")
  .argument("<value>", "Value to set")
  .description("Set a config value")
  .exitOverride()
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

config
  .command("get")
  .argument("<key>", "Config key (runner, api-url, api-key, telemetry)")
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

// ── mthds setup runner <name> ──────────────────────────────────────
const setup = program.command("setup").exitOverride();

setup
  .command("runner <name>")
  .description(`Set up a runner (${RUNNER_NAMES.join(", ")})`)
  .exitOverride()
  .action(async (name: string) => {
    await installRunner(name);
  });

// ── mthds package <subcommand> (stubs — use mthds-python) ──────────
const packageCmd = program
  .command("package")
  .description("Package management (use mthds-python for full implementation)")
  .exitOverride();

packageCmd.command("init").description("Initialize a METHODS.toml manifest").action(packageInit);
packageCmd.command("list").description("Display the package manifest").action(packageList);
packageCmd.command("add").argument("<dep>", "Dependency address").description("Add a dependency").action(packageAdd);
packageCmd.command("lock").description("Resolve and generate methods.lock").action(packageLock);
packageCmd.command("install").description("Install dependencies from methods.lock").action(packageInstall);
packageCmd.command("update").description("Re-resolve and update methods.lock").action(packageUpdate);

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
    p.log.info("Run mthds --help to see usage.");

    p.outro("");
    process.exit(1);
  }

  printLogo();
  p.intro("mthds");
  p.log.error((err as Error).message);
  p.outro("");
  process.exit(1);
});
