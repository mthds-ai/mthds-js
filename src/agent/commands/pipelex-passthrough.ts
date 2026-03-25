/**
 * Catch-all passthrough to pipelex-agent.
 *
 * Strips mthds-agent-only flags (--runner, --auto-install) from argv
 * and forwards everything else verbatim to pipelex-agent.
 * Flags understood by pipelex-agent (--log-level, -L) are kept.
 */

import { passthrough } from "../passthrough.js";

const STRIP_FLAGS_WITH_VALUE = new Set(["--runner"]);
const STRIP_BOOLEAN_FLAGS = new Set(["--auto-install"]);

/** Extract args for pipelex-agent by stripping mthds-agent-only flags. */
export function extractArgsForPipelexAgent(): string[] {
  const raw = process.argv.slice(2); // skip node + script
  const result: string[] = [];
  let idx = 0;
  while (idx < raw.length) {
    const arg = raw[idx]!;
    if (STRIP_FLAGS_WITH_VALUE.has(arg)) {
      idx += 2; // skip flag + value
    } else if (arg.startsWith("--runner=")) {
      idx += 1;
    } else if (STRIP_BOOLEAN_FLAGS.has(arg)) {
      idx += 1;
    } else {
      result.push(arg);
      idx++;
    }
  }
  return result;
}

/**
 * Forward all remaining args to pipelex-agent as passthrough.
 * This is the only code path for the pipelex runner.
 * passthrough() calls process.exit(), so this never returns.
 */
export function passthroughToPipelexAgent(autoInstall: boolean): void {
  const args = extractArgsForPipelexAgent();
  passthrough("pipelex-agent", args, { autoInstall });
}
