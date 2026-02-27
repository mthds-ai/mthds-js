#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { showBanner, printLogo, setLogoEnabled } from "./cli/commands/index.js";
import { setupRunner, setDefaultRunner, runnerStatus } from "./cli/commands/setup.js";
import { installMethod } from "./cli/commands/install.js";
import { configSet, configGet, configList } from "./cli/commands/config.js";
import { runMethod, runPipe } from "./cli/commands/run.js";
import {
  buildPipe,
  buildRunnerMethod,
  buildRunnerPipe,
  buildInputsMethod,
  buildInputsPipe,
  buildOutputMethod,
  buildOutputPipe,
} from "./cli/commands/build.js";
import { validateMethod, validatePipe } from "./cli/commands/validate.js";
import { packageInit } from "./cli/commands/package/init.js";
import { packageList } from "./cli/commands/package/list.js";
import { packageValidate } from "./cli/commands/package/validate.js";
import { RUNNER_NAMES } from "./runners/types.js";
import { isTelemetryEnabled, setTelemetryEnabled, getTelemetrySource } from "./config/credentials.js";
import type { RunnerType } from "./runners/types.js";
import type { Command as Cmd } from "commander";

function getRunner(cmd: Cmd): RunnerType | undefined {
  return cmd.optsWithGlobals().runner as RunnerType | undefined;
}

function collect(val: string, prev: string[]): string[] {
  return [...prev, resolve(val)];
}

function getLibraryDirs(cmd: Cmd): string[] {
  return (cmd.optsWithGlobals().libraryDir ?? []) as string[];
}

function getPackageDir(cmd: Cmd): string | undefined {
  // Package dir comes from `mthds package -C <path>`, available via optsWithGlobals
  const packageDir = cmd.optsWithGlobals().packageDir as string | undefined;
  return packageDir ? resolve(packageDir) : undefined;
}

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const program = new Command();

program
  .name("mthds")
  .version(pkg.version)
  .description("CLI for the MTHDS open standard")
  .option("--runner <type>", `Runner to use (${RUNNER_NAMES.join(", ")})`)
  .option("-L, --library-dir <dir>", "Additional library directory (can be repeated)", collect, [] as string[])
  .option("--no-logo", "Suppress the ASCII logo")
  .exitOverride()
  .configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  })
  .hook("preAction", (thisCommand) => {
    if (thisCommand.opts().logo === false) {
      setLogoEnabled(false);
    }
  });

// ── mthds run method|pipe ─────────────────────────────────────────────
const run = program
  .command("run")
  .description("Execute a pipeline")
  .exitOverride();

run
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code (overrides method's main_pipe)")
  .option("-i, --inputs <file>", "Path to JSON inputs file")
  .option("-o, --output <file>", "Path to save output JSON")
  .option("--no-output", "Skip saving output to file")
  .option("--no-pretty-print", "Skip pretty printing the output")
  .description("Run an installed method by name")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: Record<string, string | boolean | undefined>, cmd: Cmd) => {
    await runMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) } as Parameters<typeof runMethod>[1]);
  });

run
  .command("pipe")
  .argument("<target>", "Pipe code or .mthds bundle file")
  .option("--pipe <code>", "Pipe code (when target is a bundle)")
  .option("-i, --inputs <file>", "Path to JSON inputs file")
  .option("-o, --output <file>", "Path to save output JSON")
  .option("--no-output", "Skip saving output to file")
  .option("--no-pretty-print", "Skip pretty printing the output")
  .description("Run a pipe by code or bundle file")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: Record<string, string | boolean | undefined>, cmd: Cmd) => {
    await runPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) } as Parameters<typeof runPipe>[1]);
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
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (brief: string, options: { output?: string }, cmd: Cmd) => {
    await buildPipe(brief, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

const buildRunnerCmd = build
  .command("runner")
  .description("Generate Python runner code for a pipe")
  .exitOverride();

buildRunnerCmd
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code to generate runner for")
  .option("-o, --output <file>", "Path to save the generated Python file")
  .description("Generate runner for an installed method")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: { pipe?: string; output?: string }, cmd: Cmd) => {
    await buildRunnerMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

buildRunnerCmd
  .command("pipe")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate runner for")
  .option("-o, --output <file>", "Path to save the generated Python file")
  .description("Generate runner for a pipe by bundle path")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; output?: string }, cmd: Cmd) => {
    await buildRunnerPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

const buildInputsCmd = build
  .command("inputs")
  .description("Generate example input JSON for a pipe")
  .exitOverride();

buildInputsCmd
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code to generate inputs for")
  .description("Generate inputs for an installed method")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: { pipe?: string }, cmd: Cmd) => {
    await buildInputsMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

buildInputsCmd
  .command("pipe")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate inputs for")
  .description("Generate inputs for a pipe by bundle path")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string }, cmd: Cmd) => {
    await buildInputsPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

const buildOutputCmd = build
  .command("output")
  .description("Generate output representation for a pipe")
  .exitOverride();

buildOutputCmd
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code to generate output for")
  .option("--format <format>", "Output format (json, python, schema)", "schema")
  .description("Generate output for an installed method")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: { pipe?: string; format?: string }, cmd: Cmd) => {
    await buildOutputMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

buildOutputCmd
  .command("pipe")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate output for")
  .option("--format <format>", "Output format (json, python, schema)", "schema")
  .description("Generate output for a pipe by bundle path")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; format?: string }, cmd: Cmd) => {
    await buildOutputPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

// ── mthds validate method|pipe ────────────────────────────────────────
const validate = program
  .command("validate")
  .description("Validate a method or pipe")
  .exitOverride();

validate
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code to validate (overrides method's main_pipe)")
  .description("Validate an installed method")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: { pipe?: string }, cmd: Cmd) => {
    await validateMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

validate
  .command("pipe")
  .argument("<target>", ".mthds bundle file or pipe code")
  .option("--pipe <code>", "Pipe code that must exist in the bundle")
  .option("--bundle <file>", "Bundle file path (alternative to positional)")
  .description("Validate a pipe by code or bundle file (.mthds)")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; bundle?: string }, cmd: Cmd) => {
    await validatePipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

// ── mthds install [address] (JS-only) ──────────────────────────────
program
  .command("install")
  .argument("[address]", "GitHub repo (org/repo or https://github.com/org/repo)")
  .option("--local <path>", "Install from a local directory")
  .option("--method <name>", "Install only the specified method (by name)")
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

// ── mthds runner setup|set-default|status ────────────────────────────
const runnerCmd = program.command("runner").description("Runner management").exitOverride();

runnerCmd
  .command("setup")
  .argument("<name>", `Runner name (${RUNNER_NAMES.join(", ")})`)
  .description(`Initialize a runner (${RUNNER_NAMES.join(", ")})`)
  .exitOverride()
  .action(async (name: string) => {
    await setupRunner(name);
  });

runnerCmd
  .command("set-default")
  .argument("<name>", `Runner name (${RUNNER_NAMES.join(", ")})`)
  .description(`Set the default runner (${RUNNER_NAMES.join(", ")})`)
  .exitOverride()
  .action(async (name: string) => {
    await setDefaultRunner(name);
  });

runnerCmd
  .command("status")
  .description("Show runner configuration and status")
  .exitOverride()
  .action(async () => {
    await runnerStatus();
  });

// ── mthds telemetry enable|disable ──────────────────────────────────
const telemetry = program.command("telemetry").description("Manage anonymous usage telemetry").exitOverride();

telemetry
  .command("enable")
  .description("Enable anonymous telemetry")
  .exitOverride()
  .action(() => {
    printLogo();
    p.intro("mthds telemetry");
    setTelemetryEnabled(true);
    p.log.success("Telemetry enabled.");
    p.outro("");
  });

telemetry
  .command("disable")
  .description("Disable anonymous telemetry")
  .exitOverride()
  .action(() => {
    printLogo();
    p.intro("mthds telemetry");
    setTelemetryEnabled(false);
    p.log.success("Telemetry disabled.");
    p.outro("");
  });

telemetry
  .command("status")
  .description("Show current telemetry status")
  .exitOverride()
  .action(() => {
    printLogo();
    p.intro("mthds telemetry");
    const enabled = isTelemetryEnabled();
    const source = getTelemetrySource();
    const sourceLabel = source === "env" ? " (from env)" : source === "default" ? " (default)" : "";
    p.log.info(`Telemetry is ${enabled ? "enabled" : "disabled"}${sourceLabel}`);
    p.outro("");
  });

// ── mthds package <subcommand> ──────────────────────────────────────
const packageCmd = program
  .command("package")
  .description("Package management")
  .option("-C, --package-dir <path>", "Package directory (defaults to current directory)")
  .exitOverride();

packageCmd
  .command("init")
  .description("Initialize a METHODS.toml manifest")
  .exitOverride()
  .action(async (_opts: Record<string, unknown>, cmd: Cmd) => {
    await packageInit({ directory: getPackageDir(cmd) });
  });

packageCmd
  .command("list")
  .description("Display the package manifest")
  .exitOverride()
  .action((_opts: Record<string, unknown>, cmd: Cmd) => {
    packageList({ directory: getPackageDir(cmd) });
  });

packageCmd
  .command("validate")
  .description("Validate the METHODS.toml manifest")
  .exitOverride()
  .action(async (_opts: Record<string, unknown>, cmd: Cmd) => {
    await packageValidate({ directory: getPackageDir(cmd) });
  });

// Default: show banner
program.action(() => {
  showBanner();
});

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // --version: print version and exit
    if (err.code === "commander.version") {
      console.log(pkg.version);
      process.exit(0);
    }

    // --help: show banner and exit
    if (err.exitCode === 0) {
      showBanner();
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
