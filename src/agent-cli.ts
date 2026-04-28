#!/usr/bin/env node

/**
 * mthds-agent — machine-oriented CLI for AI agents.
 *
 * Native commands output structured JSON. Runner-aware commands
 * route through the configured runner (API = JSON, pipelex = passthrough).
 *
 * Runner dispatch:
 *   --runner=pipelex (default): all runner-aware commands are forwarded
 *     verbatim to pipelex-agent as passthrough.
 *   --runner=api: runner-aware commands are registered with full arg parsing
 *     and call the MTHDS API.
 */

import { Command, CommanderError, Option } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "./agent/output.js";
import { registerApiRunnerCommands } from "./agent/commands/api-commands.js";
import { registerPipelexRunnerCommands } from "./agent/commands/pipelex-commands.js";
import { passthroughToPipelexAgent } from "./agent/commands/pipelex-passthrough.js";
import { registerPlxtCommands } from "./agent/commands/plxt.js";
import { agentDoctor, OutputFormat } from "./agent/commands/doctor.js";
import { agentUpdateCheck } from "./agent/commands/update-check.js";
import { agentUpgrade } from "./agent/commands/upgrade.js";
import { agentBootstrap } from "./agent/commands/bootstrap.js";
import { agentCodexInstallHook } from "./agent/commands/codex.js";
import { agentCodexHook } from "./agent/commands/codex-hook.js";
import { agentConfigGet, agentConfigList, agentConfigSet } from "./agent/commands/config.js";
import { agentInstall } from "./agent/commands/install.js";
import { agentPublish } from "./agent/commands/publish.js";
import { agentShare } from "./agent/commands/share.js";
import { checkBinaryVersion } from "./installer/runtime/version-check.js";
import { uvToolInstallSync } from "./installer/runtime/installer.js";
import { BINARY_RECOVERY, buildInstallCommand } from "./agent/binaries.js";
import { agentPackageInit, agentPackageList, agentPackageValidate } from "./agent/commands/package.js";
import { createRunner } from "./runners/registry.js";
import { Runners, RUNNER_NAMES } from "./runners/types.js";
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
  let raw: string | undefined;
  for (let idx = 0; idx < argv.length; idx++) {
    if (argv[idx] === "--runner" && argv[idx + 1]) { raw = argv[idx + 1]; break; }
    const eqMatch = argv[idx]?.match(/^--runner=(.+)$/);
    if (eqMatch) { raw = eqMatch[1]; break; }
  }
  if (!raw) {
    // Fall back to config default
    try {
      const configModule = require("./config/config.js") as { loadConfig: () => { runner?: string } };
      const cfg = configModule.loadConfig();
      if (cfg.runner) raw = cfg.runner;
    } catch {
      // Config not available — default to pipelex
    }
  }
  if (!raw) return Runners.PIPELEX;
  if (RUNNER_NAMES.includes(raw as RunnerType)) return raw as RunnerType;
  agentError(
    `Unknown runner: "${raw}". Valid values: ${RUNNER_NAMES.join(", ")}`,
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
  );
  throw new Error("unreachable");
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
  .description("Machine-oriented CLI for AI agents")
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
    const recovery = BINARY_RECOVERY["pipelex"];
    const check = checkBinaryVersion(recovery);

    if (check.status === "ok") {
      agentSuccess({ success: true, already_installed: true, message: "pipelex is already installed and up to date" });
      return;
    }

    const action = check.status === "outdated" ? "upgrade" : "install";
    try {
      uvToolInstallSync(recovery.uv_package, recovery.version_constraint);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      agentError(`Failed to ${action} pipelex: ${msg}`, "InstallError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
        hint: `${action === "upgrade" ? "Upgrade" : "Install"} manually: ${buildInstallCommand(recovery)}`,
      });
    }

    const postCheck = checkBinaryVersion(recovery);
    if (postCheck.status !== "ok") {
      const detail = postCheck.status === "missing"
        ? "pipelex was installed but is not reachable in PATH."
        : `pipelex was ${action === "upgrade" ? "upgraded" : "installed"} but version check failed (status: ${postCheck.status}, installed: ${postCheck.installed_version}, needs: ${recovery.version_constraint}).`;
      const hint = postCheck.status === "missing"
        ? "Restart your shell or add the install directory to your PATH."
        : `${action === "upgrade" ? "Upgrade" : "Install"} manually: ${buildInstallCommand(recovery)}`;
      agentError(detail, "InstallError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
        hint,
      });
    }
    agentSuccess({
      success: true,
      already_installed: action === "upgrade",
      message: action === "upgrade" ? "pipelex upgraded successfully" : "pipelex installed successfully",
      installed_version: postCheck.installed_version,
    });
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
  .addOption(new Option("--format <format>", "Output format").choices(["markdown", "json"]).default("markdown"))
  .exitOverride()
  .action(async (options: { format?: string }) => {
    const fmt = options.format === "json" ? OutputFormat.JSON : OutputFormat.MARKDOWN;
    await agentDoctor(fmt);
  });

// ── mthds-agent update-check ──────────────────────────────────────

program
  .command("update-check")
  .description("Check if binary dependencies need updating")
  .option("--force", "Ignore cache and snooze, re-check all binaries")
  .option("--snooze", "Snooze upgrade reminders for this version set")
  .exitOverride()
  .action(async (opts: { force?: boolean; snooze?: boolean }) => {
    await agentUpdateCheck(opts);
  });

// ── mthds-agent upgrade ───────────────────────────────────────────

program
  .command("upgrade")
  .description("Upgrade Python binary dependencies (pipelex, plxt)")
  .exitOverride()
  .action(async () => {
    await agentUpgrade();
  });

// ── mthds-agent bootstrap ─────────────────────────────────────────

program
  .command("bootstrap")
  .description("Bootstrap environment: install uv and all binary dependencies")
  .option("--dev", "Install from local source paths instead of PyPI (for CCC/worktree dev)")
  .exitOverride()
  .action(async (opts: { dev?: boolean }) => {
    await agentBootstrap({ dev: opts.dev });
  });

// ── mthds-agent codex ─────────────────────────────────────────────

const codex = program
  .command("codex")
  .description("Codex plugin helpers (hook runtime + install)")
  .exitOverride();

codex
  .command("install-hook")
  .description("Idempotently wire the mthds PostToolUse(apply_patch) hook into ~/.codex/hooks.json")
  .exitOverride()
  .action(async () => {
    await agentCodexInstallHook();
  });

codex
  .command("hook")
  .description("Codex PostToolUse(apply_patch) hook runtime — invoked by Codex, not directly")
  .exitOverride()
  .action(async () => {
    await agentCodexHook();
  });

// ── Runner dispatch ──────────────────────────────────────────────────
// API runner: register per-command handlers with full arg parsing.
// Pipelex runner: register passthrough stubs that forward to pipelex-agent.

if (isApiRunner) {
  const getLibraryDirs = () => (program.optsWithGlobals().libraryDir ?? []) as string[];
  registerApiRunnerCommands(program, (): Runner => {
    const libraryDirs = getLibraryDirs();
    return createRunner(Runners.API, libraryDirs.length ? libraryDirs : undefined);
  });
} else {
  registerPipelexRunnerCommands(program, () => getAutoInstall(program));
}

// Default action — handle no command or unrecognized commands.
// With program.action() defined, Commander routes unknown operands here
// as positional args rather than emitting command:*.
program.action((_opts: unknown, cmd: Command) => {
  if (cmd.args.length > 0) {
    if (!isApiRunner) {
      passthroughToPipelexAgent(getAutoInstall(program));
    } else {
      agentError(
        `Unknown command: ${cmd.args[0]}. Run mthds-agent --help for usage.`,
        "ArgumentError",
        { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
      );
    }
    return;
  }
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
