import type { RunnerProtocol } from "./protocol.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineRequest,
  PipelineStartResponse,
} from "./pipeline.js";
import type {
  StartRunOptions,
  RunPublic,
  RunRead,
  RunResult,
  RunResultState,
  RunStatus,
  WaitForResultOptions,
} from "./runs.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineRequestError,
  RunFailedError,
  RunTimeoutError,
} from "./exceptions.js";

interface MthdsApiClientOptions {
  apiToken?: string;
  apiBaseUrl?: string;
}

/** Low-level transport over a generic fetch, before status interpretation. */
interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

// Run-management routes live on the platform surface; pipeline execution lives
// on the runner surface. The platform `POST /runs` is what creates the RUN row
// that the self-healing `by-id` endpoints read — starting via the runner alone
// would leave nothing to poll.
const PLATFORM_RUNS = "platform/v1/runs";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single status/result GETs; the gateway caps responses at 30s.
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_DEGRADED_RETRY_SECONDS = 5; // matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.

/**
 * Client for the Pipelex hosted API.
 *
 * Two surfaces, deliberately kept distinct:
 * - **runner** (`/runner/v1/pipeline/*`) — `executePipeline` / `startPipeline`,
 *   the stateless execution engine. `executePipeline` blocks and is subject to
 *   the API Gateway's 30s ceiling.
 * - **platform** (`/platform/v1/runs*`) — `startRun` / `getRun` / `getResult` /
 *   `waitForResult`, the durable run lifecycle. This is the path that survives
 *   hours-long runs and lets an agent resume by `run_id`.
 */
export class MthdsApiClient implements RunnerProtocol {
  private readonly apiToken: string | undefined;
  private readonly apiBaseUrl: string;

  constructor(options: MthdsApiClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.PIPELEX_API_KEY;

    const resolvedBaseUrl = options.apiBaseUrl ?? process.env.PIPELEX_API_URL;
    if (!resolvedBaseUrl) {
      throw new ClientAuthenticationError(
        "API base URL is required for API execution"
      );
    }
    this.apiBaseUrl = resolvedBaseUrl.replace(/\/+$/, "");
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller.
   */
  private async requestRaw(
    method: "GET" | "POST",
    endpoint: string,
    options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<RawResponse> {
    const url = `${this.apiBaseUrl}/${endpoint}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    const hasBody = options.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
      timeoutMs
    );
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // A caller-initiated abort (not our timeout) propagates untouched so
      // `waitForResult` callers can distinguish "I stopped waiting" from a
      // network failure.
      if (userSignal?.aborted) throw err;
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // Our timeout aborts the controller with a "TimeoutError" DOMException.
      const code = extractNetworkErrorCode(err);
      throw new ApiUnreachableError(
        `Could not reach Pipelex API at ${this.apiBaseUrl} (${code ?? "network error"})`,
        this.apiBaseUrl,
        code,
        { cause: err }
      );
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    }

    const body = await response.text().catch(() => "");
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    };
  }

  private throwApiResponseError(
    method: "GET" | "POST",
    endpoint: string,
    res: RawResponse
  ): never {
    const { errorType, serverMessage } = parseErrorBody(res.body);
    throw new ApiResponseError(
      `API ${method} /${endpoint} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.apiBaseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage
    );
  }

  private async makeApiCall(
    endpoint: string,
    pipelineRequest: PipelineRequest
  ): Promise<unknown> {
    const res = await this.requestRaw("POST", endpoint, { body: pipelineRequest });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", endpoint, res);
    }
    return res.body ? JSON.parse(res.body) : null;
  }

  // ── Runner surface (blocking) ───────────────────────────────────────

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    if (!options.pipe_code && (!options.mthds_contents || options.mthds_contents.length === 0)) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_contents must be provided to executePipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_code: options.dynamic_output_concept_code,
    };

    const data = await this.makeApiCall("runner/v1/pipeline/execute", request);
    return data as PipelineExecuteResponse;
  }

  async startPipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse> {
    if (!options.pipe_code && (!options.mthds_contents || options.mthds_contents.length === 0)) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_contents must be provided to startPipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_code: options.dynamic_output_concept_code,
    };

    const data = await this.makeApiCall("runner/v1/pipeline/start", request);
    return data as PipelineStartResponse;
  }

  // ── Platform surface (durable run lifecycle) ────────────────────────

  /**
   * Start a run — `POST /platform/v1/runs`. Returns the created run record;
   * the run executes asynchronously. Poll `getResult`/`waitForResult` (or
   * `getRun` for status) using the returned `pipeline_run_id`.
   */
  async startRun(options: StartRunOptions): Promise<RunPublic> {
    if (!options.pipe_code && (!options.mthds_contents || options.mthds_contents.length === 0)) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_contents must be provided to start a run."
      );
    }
    const request = {
      method_id: options.method_id ?? undefined,
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
    };
    const res = await this.requestRaw("POST", PLATFORM_RUNS, {
      body: request,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", PLATFORM_RUNS, res);
    }
    return JSON.parse(res.body) as RunPublic;
  }

  /**
   * Fetch a run's status by bare id — `GET /platform/v1/runs/by-id/{run_id}`.
   * Self-healing: a finished-but-unrecorded run resolves to its true terminal
   * status on read. `degraded: true` means Temporal was unreachable and
   * `status` is the last-known value; `retry_after_seconds` carries the
   * server's backoff hint when present.
   */
  async getRun(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunRead> {
    const endpoint = `${PLATFORM_RUNS}/by-id/${encodeURIComponent(runId)}`;
    const res = await this.requestRaw("GET", endpoint, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const run = JSON.parse(res.body) as RunRead;
    const retryAfter = parseRetryAfter(res.headers);
    return retryAfter !== null ? { ...run, retry_after_seconds: retryAfter } : run;
  }

  /**
   * Single-shot result lookup — `GET /platform/v1/runs/by-id/{run_id}/result`.
   * Maps the platform's poll semantics to a discriminated union:
   * - HTTP 202 → `running` (with the `Retry-After` hint)
   * - HTTP 200 → `completed` (with the result artifacts)
   * - HTTP 409 → `failed` (terminal non-`COMPLETED`)
   * - HTTP 503 → `running` (Temporal degraded — retry, never fail a poller)
   */
  async getResult(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunResultState> {
    const endpoint = `${PLATFORM_RUNS}/by-id/${encodeURIComponent(runId)}/result`;
    const res = await this.requestRaw("GET", endpoint, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });

    if (res.status === 202 || res.status === 503) {
      return {
        state: "running",
        pipeline_run_id: runId,
        retry_after_seconds: parseRetryAfter(res.headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
      };
    }
    if (res.status === 409) {
      const { serverMessage } = parseErrorBody(res.body);
      const message = serverMessage ?? "Run finished without a result.";
      return {
        state: "failed",
        pipeline_run_id: runId,
        status: extractRunStatusFromMessage(message),
        message,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const result = JSON.parse(res.body) as RunResult;
    return { state: "completed", pipeline_run_id: runId, result };
  }

  /**
   * Poll a run to terminal state and return its result. Resolves on
   * `COMPLETED`, throws `RunFailedError` on any other terminal status, and
   * throws `RunTimeoutError` if `timeoutMs` elapses first (the run keeps
   * executing server-side — resume later by `run_id`). Honors the server's
   * `Retry-After` and an optional `AbortSignal`.
   */
  async waitForResult(
    runId: string,
    options: WaitForResultOptions = {}
  ): Promise<RunResult> {
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const startedAt = Date.now();
    let attempt = 0;

    for (;;) {
      throwIfAborted(options.signal);
      const state = await this.getResult(runId, { signal: options.signal });

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
}

// ── Module helpers ────────────────────────────────────────────────────

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ABORT_TIMEOUT";
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const KNOWN_RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
];

/**
 * The 409 detail reads "Run finished with status FAILED; no result available".
 * Pull the status word out; default to FAILED if the shape ever changes.
 */
function extractRunStatusFromMessage(message: string): RunStatus {
  const match = message.match(/status\s+([A-Z_]+)/);
  const candidate = match?.[1];
  if (candidate && (KNOWN_RUN_STATUSES as readonly string[]).includes(candidate)) {
    return candidate as RunStatus;
  }
  return "FAILED";
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

/**
 * Pipelex API serializes errors as `{"detail": {"error_type": ..., "message": ...}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s).
 * Both shapes are extracted here. Falls through silently on non-JSON bodies.
 */
function parseErrorBody(body: string): { errorType: string | undefined; serverMessage: string | undefined } {
  if (!body) return { errorType: undefined, serverMessage: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errorType: undefined, serverMessage: undefined };
  }
  if (!parsed || typeof parsed !== "object") {
    return { errorType: undefined, serverMessage: undefined };
  }
  const root = parsed as Record<string, unknown>;
  const detail = root.detail;
  let errorType: string | undefined;
  let serverMessage: string | undefined;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === "string") errorType = d.error_type;
    if (typeof d.message === "string") serverMessage = d.message;
  } else if (typeof detail === "string") {
    serverMessage = detail;
  }
  if (errorType === undefined && typeof root.error_type === "string") errorType = root.error_type;
  if (serverMessage === undefined && typeof root.message === "string") serverMessage = root.message;
  return { errorType, serverMessage };
}
