export function maskApiKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 5) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(key.length - 4)}`;
}

import { PipelexRunner } from "../../runners/pipelex-runner.js";
import { Runners } from "../../runners/types.js";
import type { Runner } from "../../runners/types.js";

export function isPipelexRunner(runner: Runner): runner is PipelexRunner {
  return runner.type === Runners.PIPELEX;
}

/**
 * Extract raw args after a given command keyword, filtering out
 * --runner / -L / --library-dir (consumed by mthds, not forwarded).
 * Handles both `--flag value` and `--flag=value` syntax.
 */
export function extractPassthroughArgs(command: string, skipCount: number): string[] {
  const argv = process.argv;
  const cmdIdx = argv.indexOf(command);
  if (cmdIdx === -1) return [];
  const raw = argv.slice(cmdIdx + skipCount);
  const result: string[] = [];
  const ownedFlags = ["--runner", "-L", "--library-dir"];
  let i = 0;
  while (i < raw.length) {
    const arg = raw[i]!;
    if (ownedFlags.includes(arg)) {
      i += 2; // skip flag + value
    } else if (arg.startsWith("--runner=") || arg.startsWith("--library-dir=")) {
      i += 1; // skip combined flag=value
    } else {
      result.push(arg);
      i++;
    }
  }
  return result;
}
