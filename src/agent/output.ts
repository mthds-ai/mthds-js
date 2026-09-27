/**
 * Structured output helpers for the mthds-agent CLI.
 *
 * Mirrors the contract from pipelex/cli/agent_cli/commands/agent_output.py:
 * - Success: JSON to stdout
 * - Error: JSON to stderr + process.exit(1)
 */

import type { BinaryRecoveryInfo } from "./binaries.js";
import { ApiResponseError } from "../runners/api/exceptions.js";

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

export type AgentErrorDomain = (typeof AGENT_ERROR_DOMAINS)[keyof typeof AGENT_ERROR_DOMAINS];

/**
 * The `error_domain` vocabulary of a runner's problem document — who can fix a
 * failure the runner reported: `input` (the caller), `config` (the runner's
 * operator) or `runtime` (nobody beforehand). When a runner's refusal carries
 * one of these, it rides the envelope's `error_domain` in place of the
 * command's own domain (see `runnerProblemExtras`), as it does in the local
 * `pipelex-agent`.
 */
export const RUNNER_ERROR_DOMAINS = ["input", "config", "runtime"] as const;

export type RunnerErrorDomain = (typeof RUNNER_ERROR_DOMAINS)[number];

function isRunnerErrorDomain(value: string | undefined): value is RunnerErrorDomain {
  return (RUNNER_ERROR_DOMAINS as readonly string[]).includes(value ?? "");
}

// ── Error hints ──────────────────────────────────────────────────────

export const AGENT_ERROR_HINTS: Record<string, string> = {
  BinaryNotFoundError: "Make sure the required CLI binary is installed and in your PATH.",
  ArgumentError: "Check the command arguments and try again.",
  ConfigError: "Run `mthds-agent config list` to see current configuration.",
  RunnerError: "Check that the runner is properly configured.",
  ValidationError: "Check the .mthds bundle for syntax or schema errors.",
  ValidateBundleError:
    "The bundle is invalid — see validation_errors for the per-error diagnostics.",
  InstallError: "Check the address and try again.",
  PackageError: "Check the METHODS.toml file and try again.",
};

// ── Re-export BinaryRecoveryInfo for callers ────────────────────────
export type { BinaryRecoveryInfo };

// ── Success output ───────────────────────────────────────────────────

export function agentSuccess(result: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// ── Markdown output (validate --format markdown) ──────────────────────

/** Emit a server-rendered Markdown success to stdout (exit 0) — the `--format markdown` valid arm. */
export function agentMarkdownSuccess(markdown: string): void {
  process.stdout.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
}

/**
 * Emit a server-rendered Markdown failure to stderr + `process.exit(1)` — the
 * `--format markdown` invalid arm (a produced negative verdict). Mirrors the
 * local CLI, which writes the failure Markdown to stderr and exits non-zero.
 */
export function agentMarkdownError(markdown: string): never {
  process.stderr.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
  process.exit(1);
}

// ── Error output ─────────────────────────────────────────────────────

export function agentError(
  message: string,
  errorType: string,
  extras?: {
    hint?: string;
    error_domain?: AgentErrorDomain | RunnerErrorDomain;
    retryable?: boolean;
    /** The correlation id of the runner request that failed — the id to hand to support. */
    request_id?: string;
    recovery?: BinaryRecoveryInfo;
    /** Verdict discriminant on a validate failure — `false` rides the envelope (mirrors the Python agent CLI). */
    is_valid?: boolean;
    /** Structured per-error diagnostics on an invalid-bundle verdict (the `/validate` 200 InvalidReport arm). */
    validation_errors?: unknown[];
    /**
     * The methods the resolver refused, with the reasons. Rides an error the
     * same way it rides a success: an agent told "no valid methods" and nothing
     * else has no way to learn that the manifests were fine and addressed to
     * another version of the standard. Every failure raised once the read has
     * happened carries it, whether or not the failure is about the refusals.
     */
    skipped_methods?: unknown[];
  },
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
  if (extras?.request_id) {
    payload.request_id = extras.request_id;
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
  if (extras?.skipped_methods !== undefined) {
    payload.skipped_methods = extras.skipped_methods;
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

// ── What a runner's refusal says ─────────────────────────────────────

/**
 * The envelope fields an error thrown by a runner call carries on, to spread
 * into `agentError`'s extras after the command's own ones. When the error is an
 * `ApiResponseError`, the runner's problem document is read the way the local
 * `pipelex-agent` reads a report: its `error_domain` replaces the command's
 * domain, its next step (`user_action.detail`) replaces the static `hint`,
 * `retryable: true` rides when the runner said a retry can succeed, and its
 * `request_id` is carried for support. A member the runner did not send leaves
 * the command's own value in place; any other error yields nothing.
 */
export function runnerProblemExtras(err: unknown): {
  error_domain?: RunnerErrorDomain;
  hint?: string;
  retryable?: true;
  request_id?: string;
} {
  if (!(err instanceof ApiResponseError)) return {};
  const extras: {
    error_domain?: RunnerErrorDomain;
    hint?: string;
    retryable?: true;
    request_id?: string;
  } = {};
  if (isRunnerErrorDomain(err.errorDomain)) extras.error_domain = err.errorDomain;
  if (err.userAction) extras.hint = err.userAction.detail;
  if (err.retryable === true) extras.retryable = true;
  if (err.requestId) extras.request_id = err.requestId;
  return extras;
}
