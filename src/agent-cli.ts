#!/usr/bin/env node

/**
 * mthds-agent — machine-oriented CLI for AI agents.
 *
 * Outputs structured JSON to stdout (success) and stderr (errors).
 * No clack, no chalk, no ora — just JSON.
 */

import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { agentError, AGENT_ERROR_DOMAINS } from "./agent/output.js";
import { registerPipelexCommands } from "./agent/commands/pipelex.js";
import { registerPlxtCommands } from "./agent/commands/plxt.js";
import {
  agentBuildPipe,
  agentBuildRunnerMethod,
  agentBuildRunnerPipe,
  agentBuildInputsMethod,
  agentBuildInputsPipe,
  agentBuildOutputMethod,
  agentBuildOutputPipe,
} from "./agent/commands/build.js";
import { agentValidateMethod, agentValidatePipe } from "./agent/commands/validate.js";
import { agentConfigSet, agentConfigGet, agentConfigList } from "./agent/commands/config.js";
import { agentInstall } from "./agent/commands/install.js";
import { RUNNER_NAMES } from "./runners/types.js";
import type { RunnerType } from "./runners/types.js";
import type { Command as Cmd } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const LOG_LEVELS = ["debug", "verbose", "info", "warning", "error", "critical"] as const;

function getRunner(cmd: Cmd): RunnerType | undefined {
  return cmd.optsWithGlobals().runner as RunnerType | undefined;
}

function collect(val: string, prev: string[]): string[] {
  return [...prev, resolve(val)];
}

function getLibraryDirs(cmd: Cmd): string[] {
  return (cmd.optsWithGlobals().libraryDir ?? []) as string[];
}

function getLogLevelArgs(cmd: Cmd): string[] {
  const logLevel = cmd.optsWithGlobals().logLevel as string | undefined;
  return logLevel ? ["--log-level", logLevel] : [];
}

const program = new Command();

program
  .name("mthds-agent")
  .version(`mthds-agent ${pkg.version}`, "-V, --version")
  .description("Machine-oriented CLI for AI agents — JSON output only")
  .option("--runner <type>", `Runner to use (${RUNNER_NAMES.join(", ")})`)
  .option("-L, --library-dir <dir>", "Additional library directory (can be repeated)", collect, [] as string[])
  .option("--log-level <level>", `Log level (${LOG_LEVELS.join(", ")})`)
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({
    writeErr: () => {},
  });

// ── mthds-agent build <subcommand> ───────────────────────────────────

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
    await agentBuildPipe(brief, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildRunnerMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildRunnerPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildInputsMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildInputsPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildOutputMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
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
    await agentBuildOutputPipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

// ── mthds-agent validate method|pipe ────────────────────────────────────

const validateCmd = program
  .command("validate")
  .description("Validate a method or pipe")
  .exitOverride();

validateCmd
  .command("method")
  .argument("<name>", "Name of the installed method")
  .option("--pipe <code>", "Pipe code to validate (overrides method's main_pipe)")
  .description("Validate an installed method")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (name: string, options: { pipe?: string }, cmd: Cmd) => {
    await agentValidateMethod(name, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

validateCmd
  .command("pipe")
  .argument("<target>", ".mthds bundle file or pipe code")
  .option("--pipe <code>", "Pipe code that must exist in the bundle")
  .option("--bundle <file>", "Bundle file path (alternative to positional)")
  .description("Validate a pipe by code or bundle file (.mthds)")
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; bundle?: string }, cmd: Cmd) => {
    await agentValidatePipe(target, { ...options, runner: getRunner(cmd), libraryDir: getLibraryDirs(cmd) });
  });

// ── mthds-agent install [address] ────────────────────────────────────

program
  .command("install")
  .argument("[address]", "GitHub repo (org/repo or https://github.com/org/repo)")
  .option("--local <path>", "Install from a local directory")
  .option("--agent <id>", "AI agent to install for (required)")
  .option("--location <loc>", "Install location: local or global (required)")
  .option("--method <name>", "Install only the specified method (by name)")
  .option("--skills", "Install MTHDS skills plugin")
  .option("--no-runner", "Skip Pipelex runner install")
  .description("Install a method package (non-interactive)")
  .exitOverride()
  .action(async (address: string | undefined, opts: {
    local?: string;
    agent?: string;
    location?: string;
    method?: string;
    skills?: boolean;
    runner?: boolean; // Commander stores --no-runner as runner: false
  }) => {
    await agentInstall(address, { ...opts, noRunner: opts.runner === false });
  });

// ── mthds-agent config set|get|list ──────────────────────────────────

const config = program.command("config").description("Manage configuration").exitOverride();

config
  .command("set")
  .argument("<key>", "Config key (runner, api-url, api-key, telemetry)")
  .argument("<value>", "Value to set")
  .description("Set a config value")
  .exitOverride()
  .action(async (key: string, value: string) => {
    await agentConfigSet(key, value);
  });

config
  .command("get")
  .argument("<key>", "Config key (runner, api-url, api-key, telemetry)")
  .description("Get a config value")
  .exitOverride()
  .action(async (key: string) => {
    await agentConfigGet(key);
  });

config
  .command("list")
  .description("List all config values")
  .exitOverride()
  .action(async () => {
    await agentConfigList();
  });

// ── mthds-agent pipelex <cmd> [args...] ──────────────────────────────

registerPipelexCommands(program, () => getLogLevelArgs(program));

// ── mthds-agent plxt <cmd> [args...] ─────────────────────────────────

registerPlxtCommands(program);

// ── Default: show version ────────────────────────────────────────────

program.action(() => {
  agentError("No command specified. Run mthds-agent --help for usage.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
});

// ── Parse ────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    if (err.exitCode === 0) {
      // Commander already wrote help/version to stdout (writeOut is not suppressed)
      process.exit(0);
    }
    const message = err.message.replace(/^error: /, "").replace(/^Error: /, "");
    agentError(message, "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  agentError((err as Error).message, "UnknownError");
});
