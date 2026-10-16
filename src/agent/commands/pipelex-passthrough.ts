/**
 * Passthrough to pipelex-agent, the action of every pipelex-runner stub.
 *
 * Strips mthds-agent-only flags (--runner, --auto-install) and the
 * silently-deprecated --log-level from argv, and forwards everything
 * else verbatim to pipelex-agent. `-L` / `--library-dir` is kept because
 * pipelex-agent understands it.
 *
 * --log-level is stripped because pipelex-agent removed the flag in
 * 0.30.1 (log suppression is unconditional). The flag is still accepted
 * at the mthds-agent surface as a silent no-op so existing invocations
 * (`mthds-agent --log-level DEBUG models`) don't break.
 *
 * `--error-format` is accepted by mthds-agent on every command and before it, but pipelex-agent
 * accepts it only on its commands, never before them, and not at all on `inputs`. A forwarded
 * command's failure is written by pipelex-agent, so the option, as `--error-format <format>` or
 * `--error-format=<format>`, is taken from wherever it stands and given back after the command,
 * the last one written winning, on every command but `inputs`, whose failures pipelex-agent always
 * writes as JSON.
 */

import { passthrough } from "../passthrough.js";
import { optionValue } from "../output.js";

const STRIP_FLAGS_WITH_VALUE = new Set(["--runner", "--log-level"]);
const STRIP_PREFIXES = ["--runner=", "--log-level="];
const STRIP_BOOLEAN_FLAGS = new Set(["--auto-install"]);
const ERROR_FORMAT_FLAG = "--error-format";
/** The token after which every argument is an operand, never an option. */
const END_OF_OPTIONS = "--";

/** How the error stream's option reaches pipelex-agent. */
export interface PipelexAgentArgsOptions {
  /**
   * Whether the command pipelex-agent runs accepts `--error-format`, so the one given is moved
   * after it; when false it is dropped. True by default.
   */
  forwardErrorFormat?: boolean;
}

/** Extract args for pipelex-agent by stripping mthds-agent-only flags. */
export function extractArgsForPipelexAgent(options: PipelexAgentArgsOptions = {}): string[] {
  const raw = process.argv.slice(2); // skip node + script
  const result: string[] = [];
  // The value mthds-agent's own error stream reads, by the one rule: the last occurrence.
  const errorFormat = optionValue(raw, ERROR_FORMAT_FLAG);
  let idx = 0;
  while (idx < raw.length) {
    const arg = raw[idx]!;
    if (arg === END_OF_OPTIONS) {
      break;
    } else if (STRIP_FLAGS_WITH_VALUE.has(arg)) {
      idx += 2; // skip flag + value
    } else if (STRIP_PREFIXES.some((p) => arg.startsWith(p))) {
      idx += 1;
    } else if (STRIP_BOOLEAN_FLAGS.has(arg)) {
      idx += 1;
    } else if (arg === ERROR_FORMAT_FLAG) {
      idx += 2;
    } else if (arg.startsWith(`${ERROR_FORMAT_FLAG}=`)) {
      idx += 1;
    } else {
      result.push(arg);
      idx++;
    }
  }
  if (errorFormat !== undefined && options.forwardErrorFormat !== false) {
    result.push(ERROR_FORMAT_FLAG, errorFormat);
  }
  // Operands after `--` are forwarded verbatim, after the options.
  result.push(...raw.slice(idx));
  return result;
}

/**
 * Forward all remaining args to pipelex-agent as passthrough.
 * This is the only code path for the pipelex runner.
 * passthrough() calls process.exit(), so this never returns.
 */
export function passthroughToPipelexAgent(
  autoInstall: boolean,
  options: PipelexAgentArgsOptions = {},
): void {
  const args = extractArgsForPipelexAgent(options);
  passthrough("pipelex-agent", args, { autoInstall });
}
