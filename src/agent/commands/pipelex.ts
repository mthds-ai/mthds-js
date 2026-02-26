/**
 * Passthrough command group that forwards to pipelex-agent.
 *
 * mthds-agent pipelex <cmd> [args...] -> pipelex-agent <cmd> [args...]
 */

import { Command } from "commander";
import { passthrough } from "../passthrough.js";

const PIPELEX_COMMANDS = [
  "validate",
  "inputs",
  "concept",
  "pipe",
  "assemble",
  "models",
  "doctor",
] as const;

const PIPELEX_RUN_SUBCOMMANDS = ["pipe", "method"] as const;

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

  for (const subcmd of PIPELEX_COMMANDS) {
    pipelexGroup
      .command(subcmd)
      .description(`Forward to pipelex-agent ${subcmd}`)
      .allowUnknownOption()
      .allowExcessArguments(true)
      .passThroughOptions()
      .action((_options: Record<string, unknown>, cmd: Command) => {
        const remaining = cmd.args;
        passthrough("pipelex-agent", [...logLevelArgs(), subcmd, ...remaining], {
          autoInstall: autoInstall(),
        });
      });
  }

  // Register `run` as a sub-group with `pipe` and `method` subcommands:
  //   mthds-agent pipelex run pipe <args> -> pipelex-agent run pipe <args>
  //   mthds-agent pipelex run method <args> -> pipelex-agent run method <args>
  const runGroup = pipelexGroup
    .command("run")
    .description("Forward to pipelex-agent run (pipe or method)")
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
        const remaining = cmd.args;
        passthrough("pipelex-agent", [...logLevelArgs(), "run", runSub, ...remaining], {
          autoInstall: autoInstall(),
        });
      });
  }
}
