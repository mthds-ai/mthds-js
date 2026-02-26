/**
 * mthds-agent doctor — check binary dependencies, configuration, and overall health.
 */

import { execFileSync } from "node:child_process";
import { agentSuccess } from "../output.js";
import { BINARY_RECOVERY } from "../binaries.js";
import type { BinaryRecoveryInfo } from "../binaries.js";
import { isBinaryInstalled } from "../../installer/runtime/check.js";
import { listConfig } from "../../config/config.js";

// ── Types ───────────────────────────────────────────────────────────

interface DependencyCheck {
  binary: string;
  installed: boolean;
  version: string | null;
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

function getBinaryVersion(bin: string): string | null {
  try {
    const output = execFileSync(bin, ["--version"], { stdio: "pipe" }).toString().trim();
    return output;
  } catch {
    return null;
  }
}

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

  // Check each known binary
  for (const recovery of Object.values(BINARY_RECOVERY)) {
    const installed = isBinaryInstalled(recovery.binary);
    dependencies.push({
      binary: recovery.binary,
      installed,
      version: installed ? getBinaryVersion(recovery.binary) : null,
      path: installed ? getBinaryPath(recovery.binary) : null,
      install_command: recovery.install_command,
      install_url: recovery.install_url,
    });

    if (!installed) {
      issues.push({
        severity: "warning",
        message: `${recovery.binary} is not installed.`,
        recovery,
      });
    }
  }

  // Config checks
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

  // Runner-specific warnings
  if (runnerValue === "api" && !apiKeyConfigured) {
    issues.push({
      severity: "warning",
      message: "Runner is set to 'api' but no API key is configured.",
    });
  }

  if (runnerValue === "pipelex") {
    const pipelexDep = dependencies.find((d) => d.binary === "pipelex-agent");
    if (pipelexDep && !pipelexDep.installed) {
      issues.push({
        severity: "error",
        message: "Runner is set to 'pipelex' but pipelex-agent is not installed.",
        recovery: BINARY_RECOVERY["pipelex-agent"],
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  agentSuccess({
    healthy: !hasErrors,
    dependencies,
    config: configEntries,
    issues,
  });
}
