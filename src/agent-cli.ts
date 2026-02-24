#!/usr/bin/env node

/**
 * mthds-agent — machine-oriented CLI for AI agents.
 *
 * Outputs structured JSON to stdout (success) and stderr (errors).
 * No clack, no chalk, no ora — just JSON.
 */

import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { agentError, AGENT_ERROR_DOMAINS } from "./agent/output.js";
import { registerPipelexCommands } from "./agent/commands/pipelex.js";
import { registerPlxtCommands } from "./agent/commands/plxt.js";
import { agentRun } from "./agent/commands/run.js";
import {
  agentBuildPipe,
  agentBuildRunner,
  agentBuildInputs,
  agentBuildOutput,
} from "./agent/commands/build.js";
import { agentValidate } from "./agent/commands/validate.js";
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

function getDirectory(cmd: Cmd): string | undefined {
  return cmd.optsWithGlobals().directory as string | undefined;
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
  .option("-d, --directory <path>", "Target package directory (defaults to current directory)")
  .option("--log-level <level>", `Log level (${LOG_LEVELS.join(", ")})`)
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

// ── mthds-agent run <target> ──────────────────────────────────────────

program
  .command("run")
  .argument("<target>", "Pipe code or .mthds bundle file")
  .option("--pipe <code>", "Pipe code (when target is a bundle)")
  .option("-i, --inputs <file>", "Path to JSON inputs file")
  .option("-o, --output <file>", "Path to save output JSON")
  .option("--no-output", "Skip saving output to file")
  .description("Execute a pipeline")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: Record<string, string | boolean | undefined>, cmd: Cmd) => {
    await agentRun(target, {
      ...options,
      runner: getRunner(cmd),
      directory: getDirectory(cmd),
    } as Parameters<typeof agentRun>[1]);
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
    await agentBuildPipe(brief, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("runner")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate runner for")
  .option("-o, --output <file>", "Path to save the generated Python file")
  .description("Generate Python runner code for a pipe")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; output?: string }, cmd: Cmd) => {
    await agentBuildRunner(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("inputs")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate inputs for")
  .description("Generate example input JSON for a pipe")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string }, cmd: Cmd) => {
    await agentBuildInputs(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

build
  .command("output")
  .argument("<target>", "Bundle file path")
  .option("--pipe <code>", "Pipe code to generate output for")
  .option("--format <format>", "Output format (json, python, schema)", "schema")
  .description("Generate output representation for a pipe")
  .allowUnknownOption()
  .allowExcessArguments(true)
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; format?: string }, cmd: Cmd) => {
    await agentBuildOutput(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

// ── mthds-agent validate <target> ────────────────────────────────────

program
  .command("validate")
  .argument("<target>", ".mthds bundle file or pipe code")
  .option("--pipe <code>", "Pipe code that must exist in the bundle")
  .option("--bundle <file>", "Bundle file path (alternative to positional)")
  .description("Validate a bundle")
  .exitOverride()
  .action(async (target: string, options: { pipe?: string; bundle?: string }, cmd: Cmd) => {
    await agentValidate(target, { ...options, runner: getRunner(cmd), directory: getDirectory(cmd) });
  });

// ── mthds-agent install [address] ────────────────────────────────────

program
  .command("install")
  .argument("[address]", "Package address (org/repo or org/repo/sub/path)")
  .option("--local <path>", "Install from a local directory")
  .option("--agent <id>", "AI agent to install for (required)")
  .option("--location <loc>", "Install location: local or global (required)")
  .option("--method <slug>", "Install only the specified method (by slug)")
  .option("--skills <list>", "Install MTHDS skills plugin")
  .option("--no-runner", "Skip Pipelex runner install")
  .description("Install a method package (non-interactive)")
  .exitOverride()
  .action(async (address: string | undefined, opts: {
    local?: string;
    agent?: string;
    location?: string;
    method?: string;
    skills?: string;
    noRunner?: boolean;
  }) => {
    await agentInstall(address, opts);
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
      // --version: print plain text version
      if (err.code === "commander.version") {
        process.stdout.write(`mthds-agent ${pkg.version}\n`);
      }
      process.exit(0);
    }
    const message = err.message.replace(/^error: /, "").replace(/^Error: /, "");
    agentError(message, "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  agentError((err as Error).message, "UnknownError");
});
