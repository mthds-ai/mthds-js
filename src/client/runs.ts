/**
 * Run-lifecycle types for the platform run surface (`/platform/v1/runs`).
 *
 * Long pipeline runs outlive the API Gateway's 30s timeout, so the SDK submits
 * a run, then polls a self-healing endpoint by bare `run_id` until the run
 * reaches a terminal state. All state lives behind `run_id` (DynamoDB +
 * Temporal), so an agent can drop the poll loop and resume later with just the
 * id.
 *
 * Wire contract mirrors `pipelex-platform`:
 *   POST /platform/v1/runs                       → RunPublic        (start)
 *   GET  /platform/v1/runs/by-id/{run_id}        → RunRead          (status, self-healing)
 *   GET  /platform/v1/runs/by-id/{run_id}/result → 202 / 200 / 409  (result)
 */

// ── Status ──────────────────────────────────────────────────────────

/**
 * Run lifecycle status. Mirrors `pipelex_shared.schemas.run.RunStatus`.
 * `STARTED` is deprecated server-side but kept here for historical rows.
 */
export type RunStatus =
  | "PENDING"
  | "STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TERMINATED"
  | "TIMED_OUT";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
]);

/** A terminal status means the run is done and will not transition again. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Only `COMPLETED` has a result; every other terminal status is a failure. */
export function isSuccessRunStatus(status: RunStatus): boolean {
  return status === "COMPLETED";
}

// ── Requests ────────────────────────────────────────────────────────

/**
 * Body of `POST /platform/v1/runs`. `pipe_code` is required by the platform.
 * Two run styles: stored method (`method_id`) or ad-hoc inline bundle
 * (`mthds_contents` + `pipe_code`, `method_id` omitted).
 */
export interface StartRunOptions {
  method_id?: string | null;
  pipe_code: string;
  mthds_contents?: string[] | null;
  inputs?: Record<string, unknown> | null;
}

// ── Responses ───────────────────────────────────────────────────────

/** A run record. Mirrors `pipelex_shared.schemas.run.RunPublic`. */
export interface RunPublic {
  pipeline_run_id: string;
  org_id: string;
  created_by_user_id: string;
  /** Owning method, or the `_adhoc` sentinel for inline runs. */
  method_id: string;
  pipe_code: string;
  workflow_id?: string | null;
  status: RunStatus;
  result_url?: string | null;
  created_at: string;
  finished_at?: string | null;
}

/**
 * A run read through the self-healing path (`RunPublic` + `degraded`).
 * When `degraded` is true, Temporal was unreachable and `status` is the
 * last-known DB value, not a freshly-derived one — pair with
 * `retry_after_seconds` (parsed from the `Retry-After` header).
 */
export interface RunRead extends RunPublic {
  degraded: boolean;
  retry_after_seconds?: number | null;
}

/** Result artifacts for a completed run. Mirrors `RunResultsResponse`. */
export interface RunResult {
  pipeline_run_id: string;
  /** Pipeline graph spec (`graphspec.json`); null if missing mid-write. */
  graph_spec?: Record<string, unknown> | null;
  /** Main output stuff (`main_stuff.json`); null if missing mid-write. */
  main_stuff?: Record<string, unknown> | null;
}

/**
 * Single-shot result lookup outcome, discriminated on `state`:
 * - `running`  — HTTP 202; poll again after `retry_after_seconds`.
 * - `completed` — HTTP 200; `result` carries the artifacts.
 * - `failed`   — HTTP 409; run reached a terminal non-`COMPLETED` status.
 */
export type RunResultState =
  | { state: "running"; pipeline_run_id: string; retry_after_seconds: number | null }
  | { state: "completed"; pipeline_run_id: string; result: RunResult }
  | { state: "failed"; pipeline_run_id: string; status: RunStatus; message: string };

// ── Polling options ─────────────────────────────────────────────────

export interface WaitForResultOptions {
  /**
   * Base poll interval in ms (default 2000). The server's `Retry-After`
   * header overrides this when it asks for a longer wait.
   */
  intervalMs?: number;
  /** Max ms to wait before throwing `RunTimeoutError` (default 1_200_000 — 20 min). */
  timeoutMs?: number;
  /** Abort the poll loop (Ctrl-C / agent walk-away). */
  signal?: AbortSignal;
  /** Invoked before each sleep so callers can drive a spinner / progress line. */
  onPoll?: (info: { attempt: number; elapsedMs: number }) => void;
}
