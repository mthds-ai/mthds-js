/**
 * Catch-all passthrough to pipelex-agent.
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
 */

import { passthrough } from "../passthrough.js";

const STRIP_FLAGS_WITH_VALUE = new Set(["--runner", "--log-level"]);
const STRIP_PREFIXES = ["--runner=", "--log-level="];
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
    } else if (STRIP_PREFIXES.some((p) => arg.startsWith(p))) {
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
