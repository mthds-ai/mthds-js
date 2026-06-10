import type { VariableMultiplicity } from "./models/pipe_output.js";
import { RunFailedError, RunTimeoutError } from "./exceptions.js";

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
 *
 * Mirrors the runner's full ad-hoc input surface — the output controls
 * (`output_name`, `output_multiplicity`, `dynamic_output_concept_ref`) are
 * forwarded through the platform to the runner.
 */
export interface StartRunOptions {
  method_id?: string | null;
  /**
   * Pipe to run. Optional: when `mthds_contents` is provided without a
   * `pipe_code`, the runner resolves the pipe from the bundle's `main_pipe`.
   * At least one of `pipe_code` / `mthds_contents` must be set.
   */
  pipe_code?: string | null;
  mthds_contents?: string[] | null;
  inputs?: Record<string, unknown> | null;
  /** Name of the output slot to write to. */
  output_name?: string | null;
  /** Output multiplicity: `false`/`true` or an exact count. */
  output_multiplicity?: VariableMultiplicity | null;
  /** Override for the dynamic output concept ref. */
  dynamic_output_concept_ref?: string | null;
}

// ── Responses ───────────────────────────────────────────────────────

/**
 * A run record. Mirrors `pipelex_shared.schemas.run.RunPublic` on the hosted
 * platform. The identity fields (`org_id`, `created_by_user_id`, `method_id`)
 * are optional because the open-source runner serves the same lifecycle without
 * them — the runner is identity-free; only the platform layers them on.
 */
export interface RunPublic {
  pipeline_run_id: string;
  org_id?: string | null;
  created_by_user_id?: string | null;
  /** Owning method, or the `_adhoc` sentinel for inline runs (platform only). */
  method_id?: string | null;
  pipe_code?: string | null;
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

/**
 * Result artifacts for a completed run.
 *
 * Hosted (platform): `main_stuff` + `graph_spec`, mirroring `RunResultsResponse`.
 * Self-hosted (runner): the runner returns its native execute response, so
 * `pipe_output` carries the output and `main_stuff`/`graph_spec` may be absent.
 * Consumers read `main_stuff ?? pipe_output` (the documented output-shape
 * difference between the two tiers).
 */
export interface RunResult {
  pipeline_run_id: string;
  /** Pipeline graph spec (`graphspec.json`); null if missing mid-write. */
  graph_spec?: Record<string, unknown> | null;
  /** Main output stuff (`main_stuff.json`); null if missing mid-write. */
  main_stuff?: Record<string, unknown> | null;
  /** Self-hosted runner's native pipe output (when there is no platform). */
  pipe_output?: Record<string, unknown> | null;
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

// ── Poll loop ───────────────────────────────────────────────────────

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.

/** A single result lookup — the primitive the poll loop drives. */
export type FetchResultOnce = (
  runId: string,
  options?: { signal?: AbortSignal }
) => Promise<RunResultState>;

/**
 * Poll a single-shot result lookup (`fetchOnce`) until the run reaches a
 * terminal state. Returns the artifacts on `COMPLETED`, throws `RunFailedError`
 * on any other terminal status, and throws `RunTimeoutError` if `timeoutMs`
 * elapses first (the run keeps executing server-side — re-poll by id later).
 *
 * The single owner of the wait/poll/Retry-After/abort logic. Both
 * `MthdsApiClient.waitForResult` and `BaseRunner.waitForResult` delegate here,
 * so the behavior can never drift between the wire client and the runner layer.
 */
export async function pollUntilResult(
  fetchOnce: FetchResultOnce,
  runId: string,
  options: WaitForResultOptions = {}
): Promise<RunResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    throwIfAborted(options.signal);
    const state = await fetchOnce(runId, { signal: options.signal });

    if (state.state === "completed") {
      return state.result;
    }
    if (state.state === "failed") {
      throw new RunFailedError(state.message, runId, state.status);
    }

    attempt += 1;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new RunTimeoutError(
        `Run ${runId} did not reach a terminal state within ${timeoutMs}ms.`,
        runId,
        timeoutMs
      );
    }
    options.onPoll?.({ attempt, elapsedMs });

    const retryMs = state.retry_after_seconds != null ? state.retry_after_seconds * 1000 : 0;
    const waitMs = Math.min(Math.max(intervalMs, retryMs), timeoutMs - elapsedMs);
    await sleep(waitMs, options.signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The run poll was aborted.", "AbortError");
}

/** Sleep that resolves after `ms`, or rejects immediately if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
