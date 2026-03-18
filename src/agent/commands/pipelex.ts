/**
 * Passthrough command group that forwards to pipelex-agent.
 *
 * mthds-agent pipelex <cmd> [args...] -> pipelex-agent <cmd> [args...]
 */

import { Command } from "commander";
import { passthrough } from "../passthrough.js";

/** Options that pipelex-agent accepts only at the top level (before the subcommand). */
const TOP_LEVEL_OPTIONS = ["--log-level"] as const;

/**
 * Extract top-level options from remaining args so they can be prepended
 * before the subcommand. Commander.js's passThroughOptions prevents the
 * parent program from consuming these when they appear after subcommand args.
 */
function extractTopLevelOptions(args: string[]): {
  topLevel: string[];
  rest: string[];
} {
  const topLevel: string[] = [];
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if ((TOP_LEVEL_OPTIONS as readonly string[]).includes(arg)) {
      topLevel.push(arg, args[i + 1] ?? "");
      i += 2;
    } else if (TOP_LEVEL_OPTIONS.some((opt) => arg.startsWith(`${opt}=`))) {
      topLevel.push(arg);
      i += 1;
    } else {
      rest.push(arg);
      i++;
    }
  }
  return { topLevel, rest };
}

const PIPELEX_COMMANDS = [
  "init",
  "validate",
  "inputs",
  "concept",
  "pipe",
  "assemble",
  "models",
  "doctor",
] as const;

/** Commands forwarded to `pipelex` (interactive CLI) instead of `pipelex-agent`. */
const PIPELEX_INTERACTIVE_COMMANDS = ["login"] as const;

const PIPELEX_RUN_SUBCOMMANDS = ["pipe", "bundle", "method"] as const;

export function registerPipelexCommands(
  program: Command,
  logLevelArgs: () => string[],
  autoInstall: () => boolean
): void {
  const pipelexGroup = program
    .command("pipelex")
    .description("Forward commands to pipelex-agent")
    .passThroughOptions()
    .allowUnknownOption();

  // Interactive commands go to `pipelex` (not pipelex-agent) because they
  // require browser interaction (e.g. login opens the browser for OAuth).
  for (const subcmd of PIPELEX_INTERACTIVE_COMMANDS) {
    pipelexGroup
      .command(subcmd)
      .description(`Forward to pipelex ${subcmd}`)
      .allowUnknownOption()
      .allowExcessArguments(true)
      .passThroughOptions()
      .action((_options: Record<string, unknown>, cmd: Command) => {
        const remaining = cmd.args;
        passthrough("pipelex", [subcmd, "--no-logo", ...remaining], {
          autoInstall: autoInstall(),
        });
      });
  }

  for (const subcmd of PIPELEX_COMMANDS) {
    pipelexGroup
      .command(subcmd)
      .description(`Forward to pipelex-agent ${subcmd}`)
      .allowUnknownOption()
      .allowExcessArguments(true)
      .passThroughOptions()
      .action((_options: Record<string, unknown>, cmd: Command) => {
        const { topLevel, rest } = extractTopLevelOptions(cmd.args);
        passthrough("pipelex-agent", [...logLevelArgs(), ...topLevel, subcmd, ...rest], {
          autoInstall: autoInstall(),
        });
      });
  }

  // Register `run` as a sub-group with `pipe` and `method` subcommands:
  //   mthds-agent pipelex run pipe <args> -> pipelex-agent run pipe <args>
  //   mthds-agent pipelex run method <args> -> pipelex-agent run method <args>
  const runGroup = pipelexGroup
    .command("run")
    .description("Forward to pipelex-agent run (pipe, bundle, or method)")
    .passThroughOptions()
    .allowUnknownOption();

  for (const runSub of PIPELEX_RUN_SUBCOMMANDS) {
    runGroup
      .command(runSub)
      .description(`Forward to pipelex-agent run ${runSub}`)
      .allowUnknownOption()
      .allowExcessArguments(true)
      .passThroughOptions()
      .action((_options: Record<string, unknown>, cmd: Command) => {
        const { topLevel, rest } = extractTopLevelOptions(cmd.args);
        passthrough("pipelex-agent", [...logLevelArgs(), ...topLevel, "run", runSub, ...rest], {
          autoInstall: autoInstall(),
        });
      });
  }
}
