/**
 * API-runner exceptions — transport errors raised by `MthdsApiClient`. All
 * derive from the protocol-level `PipelineRequestError`
 * (`protocol/exceptions.ts`), except `ClientAuthenticationError`. Mirrors
 * `mthds/runners/api/exceptions.py`.
 *
 * The durable run-lifecycle errors (`RunFailedError`, `RunTimeoutError`,
 * `RunLifecycleUnavailableError`) are gone — the durable run API now lives in
 * `@pipelex/sdk` / `pipelex-agent`.
 */

import { PipelineRequestError } from "../../protocol/exceptions.js";
import type { ValidationErrorItem } from "./models.js";

export { PipelineRequestError };

export class ClientAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAuthenticationError";
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
 * Thrown when the blocking `execute` (`POST /v1/execute`) is killed by the
 * hosted gateway's ~30s synchronous-request limit. The blocking path cannot
 * run methods longer than 30s behind the hosted gateway — use the durable run
 * API (now provided by `@pipelex/sdk` / `pipelex-agent`) to start the run and
 * poll its result by id instead.
 */
export class PipelineExecuteTimeoutError extends PipelineRequestError {
  public readonly elapsedMs: number;

  constructor(elapsedMs: number, options?: { cause?: unknown }) {
    const seconds = Math.round(elapsedMs / 1000);
    super(
      `The Pipelex Hosted API times out synchronous requests after ~30s — this run took ${seconds}s. ` +
        "The blocking execute path can't run methods longer than 30s behind the gateway. " +
        "Start the run and poll for its result by id instead, using the durable run API " +
        "(now provided by `@pipelex/sdk` / `pipelex-agent`).",
      options,
    );
    this.name = "PipelineExecuteTimeoutError";
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Thrown when `execute()` receives a 202 instead of a final result.
 *
 * The MTHDS Protocol permits an implementation to degrade a synchronous
 * `/execute` into an accepted-async response (202 with a `Location` header)
 * when it cannot hold the connection open. The run keeps executing
 * server-side — resume by `runId` using the durable run API (now provided by
 * `@pipelex/sdk` / `pipelex-agent`, or the `location` status resource when
 * provided).
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

export class ApiResponseError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  public readonly errorType: string | undefined;
  public readonly serverMessage: string | undefined;
  /**
   * Structured per-error diagnostics on a problem body that carries a top-level
   * `validation_errors[]` — the **build routes** (`POST /v1/build/*`), which still
   * reject an invalid bundle with a 422.
   *
   * `POST /v1/validate` no longer routes content errors here: an invalid bundle is
   * a produced verdict (a **200** `PipelexInvalidReport` whose `validation_errors[]`
   * the caller reads off the returned value), not an `ApiResponseError`. This field
   * stays for the build-route 422s and is `undefined` for any error that carries no
   * per-error list (auth, transport, a request-shape 422). A consumer must NOT
   * assume a given `error_type` implies a populated list — fall back to
   * `serverMessage` when this is empty.
   */
  public readonly validationErrors: ValidationErrorItem[] | undefined;

  constructor(
    message: string,
    apiUrl: string,
    status: number,
    statusText: string,
    responseBody: string,
    errorType: string | undefined,
    serverMessage: string | undefined,
    validationErrors: ValidationErrorItem[] | undefined,
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
    this.validationErrors = validationErrors;
  }
}
