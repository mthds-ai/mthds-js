/**
 * Generic passthrough helper for spawning an external CLI and inheriting stdio.
 * Used for pipelex-agent and plxt commands that already output JSON.
 */

import { spawnSync } from "node:child_process";
import { agentError, AGENT_ERROR_DOMAINS } from "./output.js";
import { BINARY_RECOVERY } from "./binaries.js";
import { isBinaryInstalled } from "../installer/runtime/check.js";
import { installPipelexSync, installPlxtSync } from "../installer/runtime/installer.js";

const AUTO_INSTALL_FN: Record<string, () => void> = {
  "pipelex-agent": installPipelexSync,
  plxt: installPlxtSync,
};

export function passthrough(
  bin: string,
  args: string[],
  options?: { autoInstall?: boolean }
): void {
  const recovery = BINARY_RECOVERY[bin];

  // Auto-install: attempt to install the binary before spawning
  if (options?.autoInstall && recovery?.auto_installable && !isBinaryInstalled(bin)) {
    const installFn = AUTO_INSTALL_FN[bin];
    if (installFn) {
      try {
        installFn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        agentError(
          `Failed to auto-install ${bin}: ${msg}`,
          "InstallError",
          {
            error_domain: AGENT_ERROR_DOMAINS.INSTALL,
            hint: `Install manually: ${recovery.install_command}`,
            recovery,
          }
        );
      }
      // Verify install succeeded
      if (!isBinaryInstalled(bin)) {
        agentError(
          `${bin} was installed but is not reachable in PATH.`,
          "InstallError",
          {
            error_domain: AGENT_ERROR_DOMAINS.INSTALL,
            hint: "You may need to restart your shell or add the install directory to your PATH.",
            recovery,
          }
        );
      }
    }
  }

  const result = spawnSync(bin, args, {
    stdio: "inherit",
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      const hint = recovery
        ? `Install ${recovery.package}: ${recovery.install_command}`
        : "Make sure the required CLI binary is installed and in your PATH.";
      agentError(
        `${bin} not found. Make sure it is installed and in your PATH.`,
        "BinaryNotFoundError",
        {
          error_domain: AGENT_ERROR_DOMAINS.BINARY,
          hint,
          recovery,
        }
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
