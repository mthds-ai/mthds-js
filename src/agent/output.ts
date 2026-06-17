/**
 * Structured output helpers for the mthds-agent CLI.
 *
 * Mirrors the contract from pipelex/cli/agent_cli/commands/agent_output.py:
 * - Success: JSON to stdout
 * - Error: JSON to stderr + process.exit(1)
 */

import type { BinaryRecoveryInfo } from "./binaries.js";

// ── Error domains ────────────────────────────────────────────────────

export const AGENT_ERROR_DOMAINS = {
  ARGUMENT: "argument",
  CONFIG: "config",
  RUNNER: "runner",
  PIPELINE: "pipeline",
  VALIDATION: "validation",
  INSTALL: "install",
  IO: "io",
  BINARY: "binary",
  PACKAGE: "package",
} as const;

export type AgentErrorDomain =
  (typeof AGENT_ERROR_DOMAINS)[keyof typeof AGENT_ERROR_DOMAINS];

// ── Error hints ──────────────────────────────────────────────────────

export const AGENT_ERROR_HINTS: Record<string, string> = {
  BinaryNotFoundError:
    "Make sure the required CLI binary is installed and in your PATH.",
  ArgumentError: "Check the command arguments and try again.",
  ConfigError: "Run `mthds-agent config list` to see current configuration.",
  RunnerError: "Check that the runner is properly configured.",
  ValidationError: "Check the .mthds bundle for syntax or schema errors.",
  ValidateBundleError: "The bundle is invalid — see validation_errors for the per-error diagnostics.",
  InstallError: "Check the address and try again.",
  PackageError:
    "Check the METHODS.toml file and try again.",
};

// ── Re-export BinaryRecoveryInfo for callers ────────────────────────
export type { BinaryRecoveryInfo };

// ── Success output ───────────────────────────────────────────────────

export function agentSuccess(result: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// ── Error output ─────────────────────────────────────────────────────

export function agentError(
  message: string,
  errorType: string,
  extras?: {
    hint?: string;
    error_domain?: AgentErrorDomain;
    retryable?: boolean;
    recovery?: BinaryRecoveryInfo;
    /** Verdict discriminant on a validate failure — `false` rides the envelope (mirrors the Python agent CLI). */
    is_valid?: boolean;
    /** Structured per-error diagnostics on an invalid-bundle verdict (the `/validate` 200 InvalidReport arm). */
    validation_errors?: unknown[];
  }
): never {
  const payload: Record<string, unknown> = {
    error: true,
    error_type: errorType,
    message: message,
    hint: extras?.hint ?? AGENT_ERROR_HINTS[errorType] ?? undefined,
    error_domain: extras?.error_domain ?? undefined,
  };
  if (extras?.retryable) {
    payload.retryable = true;
  }
  if (extras?.recovery) {
    payload.recovery = extras.recovery;
  }
  if (extras?.is_valid !== undefined) {
    payload.is_valid = extras.is_valid;
  }
  if (extras?.validation_errors !== undefined) {
    payload.validation_errors = extras.validation_errors;
  }

  // Remove undefined values for cleaner output
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  }

  process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(1);
}
