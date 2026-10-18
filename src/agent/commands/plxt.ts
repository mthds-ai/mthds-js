/**
 * Passthrough command group that forwards to plxt.
 *
 * mthds-agent plxt <cmd> [args...] -> plxt <cmd> [args...]
 *
 * `--error-format` is mthds-agent's own option, which every command accepts and which sets the form
 * of mthds-agent's own error stream, such as the refusal of a plxt that is missing. plxt takes no
 * such option and refuses it, so it is never forwarded, as `--error-format <format>` or
 * `--error-format=<format>`, wherever it stands before `--`. Everything from `--` on is an operand
 * and is forwarded as written, `--` included.
 */

import { Command } from "commander";
import { passthrough } from "../passthrough.js";
import { withoutOption } from "../output.js";

const PLXT_COMMANDS = ["fmt", "lint"] as const;
const ERROR_FORMAT_FLAG = "--error-format";
/** The token after which every argument is an operand, never an option. */
const END_OF_OPTIONS = "--";

/**
 * The arguments written after a forwarded command, as the command line holds them. Commander leaves
 * them in `cmd.args` as written from the first operand or unknown option on, which makes them the
 * end of `argv`, but it consumes a `--` that comes before any of them, after the command's own
 * options at most. That `--` is given back, so that what follows it stays an operand for the
 * program the command is forwarded to; a `--` that is the value of `--error-format` is no marker.
 */
export function argsAfterCommand(cmd: Command, argv: readonly string[] = process.argv): string[] {
  const args = [...cmd.args];
  const start = argv.length - args.length;
  const isSuffix = start >= 0 && args.every((arg, index) => argv[start + index] === arg);
  if (isSuffix && argv[start - 1] === END_OF_OPTIONS && argv[start - 2] !== ERROR_FORMAT_FLAG) {
    return [END_OF_OPTIONS, ...args];
  }
  return args;
}

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
        const remaining = withoutOption(argsAfterCommand(cmd), ERROR_FORMAT_FLAG);
        passthrough("plxt", [subcmd, ...remaining], { autoInstall: autoInstall() });
      });
  }
}
