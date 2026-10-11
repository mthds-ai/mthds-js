/**
 * When `mthds-agent` may print the usage-statistics notice: never on a stderr a program reads.
 *
 * Its native commands' errors are always JSON, so they never print it. A command it runs on a
 * runner may, unless the invocation's errors are JSON: `--error-format json`, or `--format json`
 * without `--error-format`. On the API runner only `validate bundle` and `validate pipe` print
 * Markdown errors at all.
 *
 * The format is read from the options Commander parsed when the command declares them, as the API
 * runner's commands do. The pipelex runner's commands declare none: they hand their arguments to
 * `pipelex-agent` unparsed, so those are read here the way its parser reads them, up to `--`, from
 * `--name value` or `--name=value`, the last one given winning. A token another option takes as
 * its value (`--inputs --format json`) cannot be told apart, and is read as the option: that errs
 * toward JSON, which only leaves the notice to a later run.
 */

import type { Command } from "commander";
import type { Invocation } from "../usage-stats/session.js";

/** The top-level commands a runner serves; every other command is native to mthds-agent. */
const RUNNER_COMMAND_GROUPS = new Set([
  "init",
  "validate",
  "run",
  "models",
  "check-model",
  "inputs",
  "codegen",
]);

/** The API runner's commands whose errors can be Markdown. */
const API_MARKDOWN_ERROR_COMMANDS = new Set(["validate bundle", "validate pipe"]);

/**
 * The values `argv` gives the options `names`, read in one pass up to `--` from `--name value` or
 * `--name=value`, the last one given winning. A value is never read as one of the options, so
 * `--format --error-format json` gives `--format` the value `--error-format`.
 */
export function scannedOptionValues(
  argv: readonly string[],
  names: readonly string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") break;
    const name = names.find((candidate) => token === candidate);
    if (name !== undefined) {
      const next = argv[index + 1];
      if (next === undefined || next === "--") continue;
      values.set(name, next);
      index++;
      continue;
    }
    const inline = names.find((candidate) => token.startsWith(`${candidate}=`));
    if (inline !== undefined) values.set(inline, token.slice(inline.length + 1));
  }
  return values;
}

function declares(command: Command, flag: string): boolean {
  return command.options.some((option) => option.long === flag);
}

/** Whether the invocation's errors are JSON: `--error-format json`, or `--format json` without it. */
export function errorsAreJson(command: Command, argv: readonly string[]): boolean {
  let format: string | undefined;
  if (declares(command, "--error-format") || declares(command, "--format")) {
    const options = command.opts<{ format?: unknown; errorFormat?: unknown }>();
    const chosen = options.errorFormat ?? options.format;
    format = typeof chosen === "string" ? chosen : undefined;
  } else {
    const values = scannedOptionValues(argv, ["--error-format", "--format"]);
    format = values.get("--error-format") ?? values.get("--format");
  }
  return format?.trim().toLowerCase() === "json";
}

/** Whether `mthds-agent` may print the notice for this invocation, on the active runner. */
export function agentNoticeAllowed(invocation: Invocation, onApiRunner: boolean): boolean {
  if (!RUNNER_COMMAND_GROUPS.has(invocation.path.split(" ")[0]!)) return false;
  if (onApiRunner && !API_MARKDOWN_ERROR_COMMANDS.has(invocation.path)) return false;
  return !errorsAreJson(invocation.command, invocation.argv);
}
