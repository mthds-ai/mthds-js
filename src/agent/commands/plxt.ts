/**
 * Passthrough command group that forwards to plxt.
 *
 * mthds-agent plxt <cmd> [args...] -> plxt <cmd> [args...]
 *
 * mthds-agent's own options, the ones declared on the program (`--error-format`, `--runner`,
 * `--log-level`, `--auto-install`, `-L`/`--library-dir`), set how mthds-agent itself runs, such as
 * the form of its own error stream when plxt is missing. plxt takes none of them and refuses them,
 * so none is ever forwarded, wherever it stands before `--`, in any form Commander reads it in:
 * `--name value`, `--name=value`, and `-Lvalue` for the short one. Everything from `--` on is an
 * operand and is forwarded as written, `--` included, wherever the `--` was written, between
 * `plxt` and its command included.
 */

import { Command } from "commander";
import type { Option } from "commander";
import { passthrough } from "../passthrough.js";
import { withoutOptions } from "../output.js";

const PLXT_COMMANDS = ["fmt", "lint"] as const;
/** The token after which every argument is an operand, never an option. */
const END_OF_OPTIONS = "--";

/** The options of mthds-agent's own a command line may hold: those taking a value, and the flags. */
export interface AgentOnlyOptions {
  valued: readonly string[];
  flags: readonly string[];
}

/** The names an option is written by, long and short. */
function optionNames(option: Option): string[] {
  return [option.long, option.short].filter((name): name is string => name !== undefined);
}

/**
 * mthds-agent's own options, every one the program declares but `--version`, which ends the
 * command line before any command runs, so that a new one is never forwarded to plxt.
 */
export function agentOnlyOptions(program: Command): AgentOnlyOptions {
  const valued: string[] = [];
  const flags: string[] = [];
  for (const option of program.options) {
    if (option.long === "--version") continue;
    (option.required || option.optional ? valued : flags).push(...optionNames(option));
  }
  return { valued, flags };
}

/**
 * Whether a `--` the command line's parser consumed stands among `tokens`, the part of the
 * command line before a command's arguments: a `--` that is not the value of an option taking
 * one, written as `--name --`. Commander consumes such a marker when it comes before any operand,
 * between `plxt` and its command included, and everything after it is an operand.
 */
function holdsEndOfOptions(tokens: readonly string[], valued: readonly string[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (valued.includes(token)) index += 1;
    else if (token === END_OF_OPTIONS) return true;
  }
  return false;
}

/**
 * The arguments written after a forwarded command, as the command line holds them. Commander leaves
 * them in `cmd.args` as written from the first operand or unknown option on, which makes them the
 * end of `argv`, but it consumes a `--` that comes before any of them, after the command's own
 * options or between `plxt` and the command. That `--` is given back, before the arguments, so
 * that what follows it stays an operand for the program the command is forwarded to; a `--` that
 * is the value of one of `valued`, an option taking a value, is no marker.
 */
export function argsAfterCommand(
  cmd: Command,
  argv: readonly string[] = process.argv,
  valued: readonly string[] = ["--error-format"],
): string[] {
  const args = [...cmd.args];
  const start = argv.length - args.length;
  const isSuffix = start >= 0 && args.every((arg, index) => argv[start + index] === arg);
  if (isSuffix && holdsEndOfOptions(argv.slice(0, start), valued)) {
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
        const { valued, flags } = agentOnlyOptions(program);
        const remaining = withoutOptions(
          argsAfterCommand(cmd, process.argv, valued),
          valued,
          flags,
        );
        passthrough("plxt", [subcmd, ...remaining], { autoInstall: autoInstall() });
      });
  }
}
