/**
 * Passthrough command group that forwards to plxt.
 *
 * mthds-agent plxt <cmd> [args...] -> plxt <cmd> [args...]
 */

import { Command } from "commander";
import { passthrough } from "../passthrough.js";

const PLXT_COMMANDS = ["fmt", "lint"] as const;

export function registerPlxtCommands(program: Command, autoInstall: () => boolean): void {
  const plxtGroup = program
    .command("plxt")
    .description("Forward commands to plxt")
    .passThroughOptions()
    .allowUnknownOption();

  for (const subcmd of PLXT_COMMANDS) {
    plxtGroup
      .command(subcmd)
      .description(`Forward to plxt ${subcmd}`)
      .allowUnknownOption()
      .allowExcessArguments(true)
      .passThroughOptions()
      .action((_options: Record<string, unknown>, cmd: Command) => {
        const remaining = cmd.args;
        passthrough("plxt", [subcmd, ...remaining], { autoInstall: autoInstall() });
      });
  }
}
