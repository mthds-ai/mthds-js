#!/usr/bin/env node

/**
 * mthds-agent — machine-oriented CLI for AI agents.
 *
 * Outputs structured JSON to stdout (success) and stderr (errors).
 * No clack, no chalk, no ora — just JSON.
 *
 * Runner dispatch:
 *   --runner=pipelex (default): all runner-aware commands are forwarded
 *     verbatim to pipelex-agent as passthrough.
 *   --runner=api: runner-aware commands are registered with full arg parsing
 *     and call the MTHDS API.
 */

import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "./agent/output.js";
import { registerApiRunnerCommands } from "./agent/commands/api-commands.js";
import { passthroughToPipelexAgent } from "./agent/commands/pipelex-passthrough.js";
import { registerPlxtCommands } from "./agent/commands/plxt.js";
import { agentDoctor } from "./agent/commands/doctor.js";
import { agentConfigGet, agentConfigList, agentConfigSet } from "./agent/commands/config.js";
import { agentInstall } from "./agent/commands/install.js";
import { agentPublish } from "./agent/commands/publish.js";
import { agentShare } from "./agent/commands/share.js";
import { isPipelexInstalled } from "./installer/runtime/check.js";
import { installPipelexSync } from "./installer/runtime/installer.js";
import { agentPackageInit, agentPackageList, agentPackageValidate } from "./agent/commands/package.js";
import { createRunner } from "./runners/registry.js";
import { Runners } from "./runners/types.js";
import type { RunnerType, Runner } from "./runners/types.js";
import type { Command as Cmd } from "commander";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const LOG_LEVELS = ["debug", "verbose", "info", "warning", "error", "critical"] as const;

// ── Runner pre-detection ─────────────────────────────────────────────
// We need to know the runner type BEFORE parseAsync() to decide which
// commands to register. Pre-scan argv for --runner.

function resolveRunnerTypeFromArgv(): RunnerType {
  const argv = process.argv;
  for (let idx = 0; idx < argv.length; idx++) {
    if (argv[idx] === "--runner" && argv[idx + 1]) return argv[idx + 1] as RunnerType;
    const eqMatch = argv[idx]?.match(/^--runner=(.+)$/);
    if (eqMatch) return eqMatch[1] as RunnerType;
  }
  // Fall back to config default
  try {
    const configModule = require("./config/config.js") as { loadConfig: () => { runner?: string } };
    const cfg = configModule.loadConfig();
    if (cfg.runner) return cfg.runner as RunnerType;
  } catch {
    // Config not available — default to pipelex
  }
  return Runners.PIPELEX;
}

const activeRunnerType = resolveRunnerTypeFromArgv();
const isApiRunner = activeRunnerType === Runners.API;

function collectPath(val: string, prev: string[]): string[] {
  return [...prev, resolve(val)];
}

function collectPlatform(val: string, prev: string[]): string[] {
  return [...prev, val];
}

function getAutoInstall(cmd: Cmd): boolean {
  return (cmd.optsWithGlobals().autoInstall as boolean) ?? false;
}

const program = new Command();

program
  .name("mthds-agent")
  .version(`mthds-agent ${pkg.version}`, "-V, --version")
  .description("Machine-oriented CLI for AI agents — JSON output only")
  .option("-L, --library-dir <dir>", "Additional library directory (can be repeated)", collectPath, [] as string[])
  .option("--log-level <level>", `Log level (${LOG_LEVELS.join(", ")})`)
  .option("--auto-install", "Automatically install missing binaries before running")
  .option("--runner <type>", "Runner to use (api, pipelex)")
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({
    writeErr: () => {},
  });

// ── Native commands (always registered) ──────────────────────────────

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
    runner?: boolean;
  }) => {
    await agentInstall(address, { ...opts, noRunner: opts.runner === false });
  });

// ── mthds-agent publish [address] ────────────────────────────────────

program
  .command("publish")
  .argument("[address]", "GitHub repo (org/repo or https://github.com/org/repo)")
  .option("--local <path>", "Publish from a local directory")
  .option("--method <name>", "Publish only the specified method (by name)")
  .description("Publish a method package to mthds.sh (telemetry only, no install)")
  .exitOverride()
  .action(async (address: string | undefined, opts: {
    local?: string;
    method?: string;
  }) => {
    await agentPublish(address, opts);
  });

// ── mthds-agent share [address] ──────────────────────────────────────

program
  .command("share")
  .argument("[address]", "GitHub repo (org/repo or https://github.com/org/repo)")
  .option("--local <path>", "Share from a local directory")
  .option("--method <name>", "Share only the specified method (by name)")
  .option("--platform <name>", "Platform to share on (x, reddit, linkedin). Can be repeated.", collectPlatform, [] as string[])
  .description("Get social media share URLs for a method package")
  .exitOverride()
  .action(async (address: string | undefined, opts: {
    local?: string;
    method?: string;
    platform?: string[];
  }) => {
    await agentShare(address, {
      ...opts,
      platform: opts.platform && opts.platform.length > 0 ? opts.platform as import("./cli/commands/share.js").SharePlatform[] : undefined,
    });
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

// ── mthds-agent package init|list|validate ───────────────────────────

const packageCmd = program
  .command("package")
  .description("Manage method packages (METHODS.toml)")
  .exitOverride();

packageCmd
  .command("init")
  .requiredOption("--address <address>", "Package address (e.g. github.com/org/repo)")
  .requiredOption("--version <version>", "Package version (semver)")
  .requiredOption("--description <desc>", "Package description")
  .option("--authors <authors>", "Comma-separated list of authors")
  .option("--license <license>", "License identifier (e.g. MIT)")
  .option("--name <name>", "Method name")
  .option("--display-name <displayName>", "Display name (human-readable, max 128 chars)")
  .option("--main-pipe <pipe>", "Main pipe code")
  .option("--force", "Overwrite existing METHODS.toml")
  .option("-C, --package-dir <path>", "Package directory (defaults to current directory)")
  .description("Initialize a new METHODS.toml")
  .exitOverride()
  .action(async (opts: {
    address: string;
    version: string;
    description: string;
    authors?: string;
    license?: string;
    name?: string;
    displayName?: string;
    mainPipe?: string;
    force?: boolean;
    packageDir?: string;
  }) => {
    await agentPackageInit({ ...opts, directory: opts.packageDir });
  });

packageCmd
  .command("list")
  .option("-C, --package-dir <path>", "Package directory (defaults to current directory)")
  .description("List package manifest contents")
  .exitOverride()
  .action(async (opts: { packageDir?: string }) => {
    await agentPackageList({ directory: opts.packageDir });
  });

packageCmd
  .command("validate")
  .option("-C, --package-dir <path>", "Package directory (defaults to current directory)")
  .description("Validate METHODS.toml")
  .exitOverride()
  .action(async (opts: { packageDir?: string }) => {
    await agentPackageValidate({ directory: opts.packageDir });
  });

// ── mthds-agent runner setup <name> ──────────────────────────────────

const runnerCmd = program
  .command("runner")
  .description("Manage runner configuration")
  .exitOverride();

const runnerSetup = runnerCmd
  .command("setup")
  .description("Set up a runner")
  .exitOverride();

runnerSetup
  .command("pipelex")
  .description("Install the Pipelex runner")
  .exitOverride()
  .action(() => {
    if (isPipelexInstalled()) {
      agentSuccess({ success: true, already_installed: true, message: "pipelex is already installed" });
      return;
    }
    try {
      installPipelexSync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentError(`Failed to install pipelex: ${msg}`, "InstallError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
        hint: "Install manually: https://pipelex.com",
      });
    }
    if (!isPipelexInstalled()) {
      agentError(
        "pipelex was installed but is not reachable in PATH.",
        "InstallError",
        {
          error_domain: AGENT_ERROR_DOMAINS.INSTALL,
          hint: "Restart your shell or add the install directory to your PATH.",
        }
      );
    }
    agentSuccess({ success: true, already_installed: false, message: "pipelex installed successfully" });
  });

runnerSetup
  .command("api")
  .description("Set up the API runner")
  .requiredOption("--api-key <key>", "API key for the MTHDS API")
  .option("--api-url <url>", "API URL (optional, uses default if omitted)")
  .exitOverride()
  .action(async (options: { apiKey: string; apiUrl?: string }) => {
    if (options.apiUrl) {
      await agentConfigSet("api-url", options.apiUrl);
    }
    await agentConfigSet("api-key", options.apiKey);
  });

// ── mthds-agent plxt <cmd> [args...] ─────────────────────────────────

registerPlxtCommands(program, () => getAutoInstall(program));

// ── mthds-agent doctor ───────────────────────────────────────────────

program
  .command("doctor")
  .description("Check binary dependencies, configuration, and overall health")
  .exitOverride()
  .action(async () => {
    await agentDoctor();
  });

// ── Runner dispatch ──────────────────────────────────────────────────
// API runner: register per-command handlers with arg parsing.
// Pipelex runner: no command registration — catch-all forwards to pipelex-agent.

if (isApiRunner) {
  const getLibraryDirs = () => (program.optsWithGlobals().libraryDir ?? []) as string[];
  registerApiRunnerCommands(program, (): Runner => {
    const libraryDirs = getLibraryDirs();
    return createRunner(Runners.API, libraryDirs.length ? libraryDirs : undefined);
  });
}

// Catch-all: forward unrecognized commands to pipelex-agent (pipelex runner)
// or error (API runner).
program.on("command:*", () => {
  if (!isApiRunner) {
    passthroughToPipelexAgent(getAutoInstall(program));
  } else {
    agentError(
      `Unknown command: ${program.args[0]}. Run mthds-agent --help for usage.`,
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }
});

// Default action (no command specified)
program.action(() => {
  agentError("No command specified. Run mthds-agent --help for usage.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
});

// ── Parse ────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    if (err.exitCode === 0) {
      process.exit(0);
    }
    const message = err.message.replace(/^error: /, "").replace(/^Error: /, "");
    agentError(message, "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  agentError((err as Error).message, "UnknownError");
});
