/**
 * Generic passthrough helper for spawning an external CLI and inheriting stdio.
 * Used for pipelex-agent and plxt commands that already output JSON.
 */

import { spawnSync } from "node:child_process";
import { agentError, AGENT_ERROR_DOMAINS } from "./output.js";

export function passthrough(bin: string, args: string[]): void {
  const result = spawnSync(bin, args, {
    stdio: "inherit",
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      agentError(
        `${bin} not found. Make sure it is installed and in your PATH.`,
        "BinaryNotFoundError",
        { error_domain: AGENT_ERROR_DOMAINS.BINARY }
      );
    }
    agentError(
      `Failed to spawn ${bin}: ${result.error.message}`,
      "BinarySpawnError",
      { error_domain: AGENT_ERROR_DOMAINS.BINARY }
    );
  }

  process.exit(result.status ?? 1);
}
