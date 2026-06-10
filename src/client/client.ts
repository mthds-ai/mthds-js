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
import { pollUntilResult } from "./runs.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
} from "./exceptions.js";

interface MthdsApiClientOptions {
  apiToken?: string;
  /**
   * Runner base URL, INCLUDING its version prefix (hosted: `.../runner/v1`;
   * self-hosted: `http://<host>/api/v1`). Runner endpoints are appended to this
   * without re-adding a version prefix; `/health` resolves to its origin root.
   */
  runnerBaseUrl?: string;
  /**
   * Platform base URL, INCLUDING its version prefix (hosted: `.../platform/v1`).
   * Optional: when omitted/empty the platform (durable run) surface is disabled
   * and calling any run-lifecycle method throws a clear hosted-only error.
   */
  platformBaseUrl?: string;
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
// would leave nothing to poll. These endpoints are appended to the platform
// base URL (which already carries the `/platform/v1` version prefix).
const PLATFORM_RUNS = "runs";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single status/result GETs; the gateway caps responses at 30s.
const DEFAULT_DEGRADED_RETRY_SECONDS = 5; // matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.

/**
 * Client for the Pipelex API, hosted or self-hosted.
 *
 * Two surfaces, deliberately kept distinct, each addressed by its own base URL
 * (which already carries the version prefix):
 * - **runner** (`<runnerBaseUrl>/pipeline/*`) — `executePipeline` /
 *   `startPipeline`, the stateless execution engine. `executePipeline` blocks
 *   and, behind the hosted gateway, is subject to the 30s ceiling.
 * - **platform** (`<platformBaseUrl>/runs*`) — `startRun` / `getRun` /
 *   `getResult` / `waitForResult`, the durable run lifecycle. This is the path
 *   that survives hours-long runs and lets an agent resume by `run_id`.
 *   Optional: when no platform base URL is configured (self-hosted runner with
 *   no run store) these methods throw a clear hosted-only error.
 */
export class MthdsApiClient implements RunnerProtocol {
  private readonly apiToken: string | undefined;
  private readonly runnerBaseUrl: string;
  private readonly platformBaseUrl: string | undefined;

  constructor(options: MthdsApiClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.PIPELEX_API_KEY;

    const resolvedRunnerUrl =
      options.runnerBaseUrl ?? process.env.PIPELEX_RUNNER_URL;
    if (!resolvedRunnerUrl) {
      throw new ClientAuthenticationError(
        "Runner base URL (`runnerUrl`) is required for API execution"
      );
    }
    this.runnerBaseUrl = resolvedRunnerUrl.replace(/\/+$/, "");

    const resolvedPlatformUrl =
      options.platformBaseUrl ?? process.env.PIPELEX_PLATFORM_URL;
    this.platformBaseUrl = resolvedPlatformUrl
      ? resolvedPlatformUrl.replace(/\/+$/, "")
      : undefined;
  }

  // ── URL resolution ───────────────────────────────────────────────────

  /** Build a full runner URL by appending an endpoint to the runner base. */
  private runnerUrl(endpoint: string): string {
    return `${this.runnerBaseUrl}/${endpoint}`;
  }

  /**
   * Resolve the base URL for the durable run lifecycle (start/poll/result).
   *
   * The lifecycle sub-paths (`runs`, `runs/by-id/{id}`, `runs/by-id/{id}/result`)
   * are served identically by two tiers, so the only difference is the base:
   * - **hosted** — the Pipelex Platform (`platformBaseUrl`), DDB+Temporal backed.
   * - **self-hosted** — the open-source runner itself (`runnerBaseUrl`), which
   *   serves the same lifecycle from its in-process store.
   * Prefer the platform when configured; otherwise fall back to the runner.
   */
  private runLifecycleBase(): string {
    return this.platformBaseUrl ?? this.runnerBaseUrl;
  }

  /** Build a full run-lifecycle URL by appending an endpoint to the lifecycle base. */
  private runLifecycleUrl(endpoint: string): string {
    return `${this.runLifecycleBase()}/${endpoint}`;
  }

  /** Origin root derived from the runner base URL — `/health` lives here, not under the version prefix. */
  private healthUrl(): string {
    return new URL("/health", this.runnerBaseUrl).toString();
  }

  /** Whether the durable platform surface is configured (hosted) or not (self-hosted). */
  hasPlatform(): boolean {
    return this.platformBaseUrl !== undefined;
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller. `url` is a fully
   * resolved absolute URL.
   */
  private async requestRaw(
    method: "GET" | "POST",
    url: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
      baseUrlForErrors?: string;
    } = {}
  ): Promise<RawResponse> {
    const baseUrlForErrors = options.baseUrlForErrors ?? this.runnerBaseUrl;
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
        `Could not reach Pipelex API at ${baseUrlForErrors} (${code ?? "network error"})`,
        baseUrlForErrors,
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
    res: RawResponse,
    baseUrlForErrors: string
  ): never {
    const { errorType, serverMessage } = parseErrorBody(res.body);
    throw new ApiResponseError(
      `API ${method} /${endpoint} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      baseUrlForErrors,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage
    );
  }

  /** POST a pipeline request to a runner endpoint and return the parsed body. */
  private async makeRunnerCall(
    endpoint: string,
    pipelineRequest: PipelineRequest
  ): Promise<unknown> {
    const res = await this.requestRaw("POST", this.runnerUrl(endpoint), {
      body: pipelineRequest,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", endpoint, res, this.runnerBaseUrl);
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

    // The blocking execute runs behind the Pipelex public API gateway, which
    // terminates a synchronous request at ~30s. A run that exceeds that comes
    // back as a gateway 503/504 (or a client abort) — translate it into a
    // clear, actionable error that points at the durable start+poll path.
    const startedAt = Date.now();
    try {
      const data = await this.makeRunnerCall("pipeline/execute", request);
      return data as PipelineExecuteResponse;
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      if (isGatewayTimeout(err, elapsedMs)) {
        throw new PipelineExecuteTimeoutError(elapsedMs, { cause: err });
      }
      throw err;
    }
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

    const data = await this.makeRunnerCall("pipeline/start", request);
    return data as PipelineStartResponse;
  }

  // ── Platform surface (durable run lifecycle) ────────────────────────

  /**
   * Start a run — `POST /platform/v1/runs`. Returns the created run record;
   * the run executes asynchronously. Poll `getResult`/`waitForResult` (or
   * `getRun` for status) using the returned `pipeline_run_id`.
   */
  async startRun(options: StartRunOptions): Promise<RunPublic> {
    // A stored method (`method_id`) carries its own `main_pipe`, so the platform
    // resolves the pipe server-side — `pipe_code` is optional in that case. For
    // ad-hoc runs, at least one of `pipe_code` / `mthds_contents` is required.
    if (
      !options.method_id &&
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0)
    ) {
      throw new PipelineRequestError(
        "Provide method_id (stored method), pipe_code, or mthds_contents to start a run."
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
    const lifecycleBase = this.runLifecycleBase();
    const res = await this.requestRaw("POST", this.runLifecycleUrl(PLATFORM_RUNS), {
      body: request,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      baseUrlForErrors: lifecycleBase,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", PLATFORM_RUNS, res, lifecycleBase);
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
    const lifecycleBase = this.runLifecycleBase();
    const endpoint = `${PLATFORM_RUNS}/by-id/${encodeURIComponent(runId)}`;
    const res = await this.requestRaw("GET", this.runLifecycleUrl(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
      baseUrlForErrors: lifecycleBase,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res, lifecycleBase);
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
    const lifecycleBase = this.runLifecycleBase();
    const endpoint = `${PLATFORM_RUNS}/by-id/${encodeURIComponent(runId)}/result`;
    const res = await this.requestRaw("GET", this.runLifecycleUrl(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
      baseUrlForErrors: lifecycleBase,
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
      this.throwApiResponseError("GET", endpoint, res, lifecycleBase);
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
    return pollUntilResult((id, opts) => this.getResult(id, opts), runId, options);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

// The Pipelex public API gateway caps synchronous requests at 30s. A failure
// at/after this threshold on the blocking execute is the timeout, not a
// transient outage — the threshold guards against mislabelling a fast 503
// (runner genuinely down) as a timeout.
const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;

function isGatewayTimeout(err: unknown, elapsedMs: number): boolean {
  if (elapsedMs < GATEWAY_TIMEOUT_THRESHOLD_MS) return false;
  if (err instanceof ApiResponseError) return err.status === 503 || err.status === 504;
  if (err instanceof ApiUnreachableError) return err.code === "ABORT_TIMEOUT";
  return false;
}

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
