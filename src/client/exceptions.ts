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
 * Thrown when the Pipelex API host cannot be reached at all (DNS failure,
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
 * Thrown when the API returned a non-2xx HTTP response. Carries structured
 * fields so callers can render meaningful UI without parsing the message:
 * - `status` / `statusText` — HTTP status from the response
 * - `responseBody` — raw response body (always retained)
 * - `errorType` / `serverMessage` — parsed from the JSON body when present
 *
 * Pipelex API serializes errors as `{"detail": {"error_type", "message"}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s).
 * Both shapes are extracted here.
 */
/**
 * Thrown when the blocking `executePipeline` (runner `/pipeline/execute`) is
 * killed by the Pipelex public API's ~30s synchronous-request limit. The
 * blocking path cannot run pipelines longer than 30s — use the durable run API
 * (start + poll) instead.
 */
export class PipelineExecuteTimeoutError extends PipelineRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The Pipelex public API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run pipelines longer than 30s. " +
        "Start the run and poll for its result instead: " +
        "`startRun()` then `waitForResult(runId)` (SDK), " +
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
 * `waitForResult`/`getResult` when the platform answers a result lookup with
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
