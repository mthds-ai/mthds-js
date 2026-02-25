/**
 * Passthrough command group that forwards to pipelex-agent.
 *
 * mthds-agent pipelex <cmd> [args...] -> pipelex-agent <cmd> [args...]
 */

import { Command } from "commander";
import { passthrough } from "../passthrough.js";

const PIPELEX_COMMANDS = [
  "run",
  "validate",
  "inputs",
  "concept",
  "pipe",
  "assemble",
  "models",
  "doctor",
] as const;

export function registerPipelexCommands(program: Command, logLevelArgs: () => string[]): void {
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
        passthrough("pipelex-agent", [...logLevelArgs(), subcmd, ...remaining]);
      });
  }
}
