/**
 * mthds-agent doctor — check binary dependencies, configuration, and overall health.
 */

import { execFileSync } from "node:child_process";
import { agentSuccess } from "../output.js";
import { BINARY_RECOVERY, buildInstallCommand } from "../binaries.js";
import type { BinaryRecoveryInfo } from "../binaries.js";
import { checkBinaryVersion } from "../../installer/runtime/version-check.js";
import { listConfig } from "../../config/config.js";

// ── Types ───────────────────────────────────────────────────────────

interface DependencyCheck {
  binary: string;
  installed: boolean;
  version: string | null;
  version_ok: boolean;
  version_constraint: string;
  path: string | null;
  install_command: string;
  install_url: string;
}

interface ConfigEntry {
  key: string;
  value: string;
  source: string;
}

interface Issue {
  severity: "error" | "warning";
  message: string;
  recovery?: BinaryRecoveryInfo;
}

// ── Helpers ─────────────────────────────────────────────────────────

function getBinaryPath(bin: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return execFileSync(cmd, [bin], { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────

export async function agentDoctor(): Promise<void> {
  const dependencies: DependencyCheck[] = [];
  const issues: Issue[] = [];

  // Config checks (parsed first so runner value is available during binary loop)
  const configEntries: ConfigEntry[] = [];
  const rawConfig = listConfig();
  let runnerValue: string | undefined;
  let apiKeyConfigured = false;

  for (const entry of rawConfig) {
    const displayValue = entry.cliKey === "api-key"
      ? (entry.value ? "configured" : "not set")
      : entry.value;
    configEntries.push({
      key: entry.cliKey,
      value: displayValue,
      source: entry.source,
    });

    if (entry.cliKey === "runner") runnerValue = entry.value;
    if (entry.cliKey === "api-key" && entry.value) apiKeyConfigured = true;
  }

  // Check each known binary
  for (const recovery of Object.values(BINARY_RECOVERY)) {
    const check = checkBinaryVersion(recovery);
    const installed = check.status !== "missing";

    dependencies.push({
      binary: recovery.binary,
      installed,
      version: check.installed_version,
      version_ok: check.status === "ok",
      version_constraint: recovery.version_constraint,
      path: installed ? getBinaryPath(recovery.binary) : null,
      install_command: buildInstallCommand(recovery),
      install_url: recovery.install_url,
    });

    if (check.status === "missing") {
      // Skip generic warning for pipelex-agent when runner=pipelex;
      // the runner-specific block below will emit a more specific error.
      if (runnerValue === "pipelex" && recovery.binary === "pipelex-agent") {
        continue;
      }
      issues.push({
        severity: "warning",
        message: `${recovery.binary} is not installed.`,
        recovery,
      });
    } else if (check.status === "outdated") {
      issues.push({
        severity: "warning",
        message: `${recovery.binary} is outdated (${check.installed_version}, needs ${recovery.version_constraint}).`,
        recovery,
      });
    } else if (check.status === "unparseable") {
      issues.push({
        severity: "warning",
        message: `Could not parse version for ${recovery.binary}.`,
        recovery,
      });
    }
  }

  // Runner-specific warnings
  if (runnerValue === "api" && !apiKeyConfigured) {
    issues.push({
      severity: "warning",
      message: "Runner is set to 'api' but no API key is configured.",
    });
  }

  if (runnerValue === "pipelex") {
    const pipelexDep = dependencies.find((dep) => dep.binary === "pipelex-agent");
    if (pipelexDep && !pipelexDep.installed) {
      issues.push({
        severity: "error",
        message: "Runner is set to 'pipelex' but pipelex-agent is not installed.",
        recovery: BINARY_RECOVERY["pipelex-agent"],
      });
    }
  }

  const hasErrors = issues.some((issue) => issue.severity === "error");

  agentSuccess({
    healthy: !hasErrors,
    dependencies,
    config: configEntries,
    issues,
  });
}
