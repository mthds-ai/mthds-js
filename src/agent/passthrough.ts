/**
 * Generic passthrough helper for spawning an external CLI and inheriting stdio.
 * Used for pipelex-agent and plxt commands that already output JSON.
 */

import { spawnSync } from "node:child_process";
import { agentError, AGENT_ERROR_DOMAINS } from "./output.js";
import { BINARY_RECOVERY, buildInstallCommand } from "./binaries.js";
import { checkBinaryVersion } from "../installer/runtime/version-check.js";
import { uvToolInstallSync } from "../installer/runtime/installer.js";

export function passthrough(
  bin: string,
  args: string[],
  options?: { autoInstall?: boolean; skipVersionCheck?: boolean }
): void {
  const recovery = BINARY_RECOVERY[bin];

  // Skip version check if caller (e.g. update-check preamble path) already verified
  if (!options?.skipVersionCheck && options?.autoInstall && recovery?.auto_installable) {
    const check = checkBinaryVersion(recovery);

    switch (check.status) {
      case "ok":
        break;

      case "missing":
        try {
          uvToolInstallSync(recovery.uv_package, recovery.version_constraint);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          agentError(
            `Failed to auto-install ${bin}: ${msg}`,
            "InstallError",
            {
              error_domain: AGENT_ERROR_DOMAINS.INSTALL,
              hint: `Install manually: ${buildInstallCommand(recovery)}`,
              recovery,
            }
          );
        }
        // Verify install succeeded and version constraint is satisfied
        {
          const postCheck = checkBinaryVersion(recovery);
          if (postCheck.status === "missing") {
            agentError(
              `${bin} was installed but is not reachable in PATH.`,
              "InstallError",
              {
                error_domain: AGENT_ERROR_DOMAINS.INSTALL,
                hint: "You may need to restart your shell or add the install directory to your PATH.",
                recovery,
              }
            );
          } else if (postCheck.status !== "ok") {
            process.stderr.write(
              JSON.stringify({
                warning: true,
                message: `Install of ${bin} may not have taken effect (status: ${postCheck.status}, installed: ${postCheck.installed_version}, needs: ${recovery.version_constraint}).`,
              }) + "\n"
            );
          }
        }
        break;

      case "outdated":
        try {
          uvToolInstallSync(recovery.uv_package, recovery.version_constraint);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          agentError(
            `Failed to upgrade ${bin} (installed ${check.installed_version}, needs ${recovery.version_constraint}): ${msg}`,
            "InstallError",
            {
              error_domain: AGENT_ERROR_DOMAINS.INSTALL,
              hint: `Upgrade manually: ${buildInstallCommand(recovery)}`,
              recovery,
            }
          );
        }
        // Verify upgrade actually satisfied the constraint
        {
          const recheck = checkBinaryVersion(recovery);
          if (recheck.status !== "ok") {
            process.stderr.write(
              JSON.stringify({
                warning: true,
                message: `Upgrade of ${bin} may not have taken effect (status: ${recheck.status}, installed: ${recheck.installed_version}, needs: ${recovery.version_constraint}).`,
              }) + "\n"
            );
          }
        }
        break;

      case "unparseable":
        // Warn to stderr but don't block execution
        process.stderr.write(
          JSON.stringify({
            warning: true,
            message: `Could not parse version for ${bin}. Proceeding anyway.`,
            version_constraint: check.version_constraint,
          }) + "\n"
        );
        break;
    }
  }

  const result = spawnSync(bin, args, {
    stdio: "inherit",
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      const hint = recovery
        ? `Install ${recovery.package}: ${buildInstallCommand(recovery)}`
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
