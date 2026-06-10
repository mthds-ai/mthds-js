export class ClientAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAuthenticationError";
  }
}

export class PipelineRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "PipelineRequestError";
  }
}

/**
 * Thrown when the MTHDS API host cannot be reached at all (DNS failure,
 * connection refused, TLS handshake failure, request timeout). The HTTP
 * exchange never produced a response — distinguish from `ApiResponseError`,
 * which represents a non-2xx response that did come back.
 *
 * `code` is the underlying network error code when available
 * (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `EAI_AGAIN`, `ABORT_TIMEOUT`).
 */
export class ApiUnreachableError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly code: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiUnreachableError";
    this.apiUrl = apiUrl;
    this.code = code;
  }
}

/**
 * Thrown when the blocking `execute` (`POST /v1/execute`) is killed by the
 * hosted gateway's ~30s synchronous-request limit. The blocking path cannot
 * run methods longer than 30s behind the hosted gateway — use the durable run
 * lifecycle (start + poll) instead.
 */
export class PipelineExecuteTimeoutError extends PipelineRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The hosted MTHDS API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run methods longer than 30s behind the gateway. " +
        "Start the run and poll for its result instead: " +
        "`start()` then `waitForResult(runId)` (SDK), " +
        "or `mthds-agent run start …` then `mthds-agent run poll <run_id>` (CLI).",
      options
    );
    this.name = "PipelineExecuteTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when a run reaches a terminal state that is not `COMPLETED`
 * (`FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`) — surfaced from
 * `waitForResult`/`getRunResult` when the server answers a result lookup with
 * HTTP 409. `runId` and `status` let callers report the outcome precisely.
 */
export class RunFailedError extends PipelineRequestError {
  public readonly runId: string;
  public readonly status: string;

  constructor(message: string, runId: string, status: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunFailedError";
    this.runId = runId;
    this.status = status;
  }
}

/**
 * Thrown when `waitForResult` exceeds its `timeoutMs` before the run reaches a
 * terminal state. The run is NOT cancelled — it keeps executing server-side and
 * can be resumed later by `runId` (the poll loop just stopped waiting).
 */
export class RunTimeoutError extends PipelineRequestError {
  public readonly runId: string;
  public readonly timeoutMs: number;

  constructor(message: string, runId: string, timeoutMs: number) {
    super(message);
    this.name = "RunTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when `execute()` receives `202 + StartAck` instead of a final result.
 *
 * The MTHDS Protocol permits an implementation to degrade a synchronous
 * `/execute` into an accepted-async response (202 with a `Location` header)
 * when it cannot hold the connection open. The run keeps executing
 * server-side — resume by `runId` (`getRunResult` / `waitForResult` on a
 * hosted deployment, or the `location` status resource when provided).
 */
export class RunStillRunningError extends PipelineRequestError {
  public readonly runId: string;
  public readonly retryAfterSeconds: number | null;
  public readonly location: string | null;

  constructor(
    message: string,
    runId: string,
    retryAfterSeconds: number | null = null,
    location: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RunStillRunningError";
    this.runId = runId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.location = location;
  }
}

/**
 * Thrown when the durable run lifecycle (`/v1/runs/*`) is not served by the
 * configured `MTHDS_API_URL`.
 *
 * Run polling is a hosted-API extension, not part of the MTHDS Protocol: the
 * open-source `pipelex-api` runner executes methods but has no run store, so
 * it 404s those routes; only a deployment that includes the platform block
 * (the hosted MTHDS API) serves status/results. Distinguished from a genuine
 * run-not-found 404, which carries the server's structured error envelope.
 */
export class RunLifecycleUnavailableError extends PipelineRequestError {
  public readonly apiUrl: string;

  constructor(message: string, apiUrl: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunLifecycleUnavailableError";
    this.apiUrl = apiUrl;
  }
}

export class ApiResponseError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  public readonly errorType: string | undefined;
  public readonly serverMessage: string | undefined;

  constructor(
    message: string,
    apiUrl: string,
    status: number,
    statusText: string,
    responseBody: string,
    errorType: string | undefined,
    serverMessage: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiResponseError";
    this.apiUrl = apiUrl;
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.errorType = errorType;
    this.serverMessage = serverMessage;
  }
}
