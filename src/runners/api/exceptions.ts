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

/**
 * What the runner says the caller should do next — the problem document's
 * `user_action` member. `kind` is the runner's coarse category of advice (the
 * reference runner emits `wait_and_retry`, `check_billing`, `check_credentials`,
 * `change_input`, `change_model`, `contact_support` or `unknown`; the set is the
 * runner's, so it is typed open), and `detail` is the advice itself, in words.
 */
export interface UserAction {
  kind: string;
  detail: string;
}

/**
 * The members of an RFC 9457 problem document that `ApiResponseError` exposes
 * beyond its message: the standard's own `type`, `title` and `instance`, and the
 * extension members a runner adds to classify the failure. Every member is
 * optional — a runner sends what it knows, and a body that is not a problem
 * document carries none of them.
 */
export interface ProblemDetails {
  /** RFC 9457 `type` — the stable URI of the error class. */
  type?: string;
  /** RFC 9457 `title` — the short human label of the error class. */
  title?: string;
  /** RFC 9457 `instance` — the occurrence (a request path or a request URN). */
  instance?: string;
  /** The request's correlation id: the body's `request_id`, else the `X-Request-ID` response header. */
  requestId?: string;
  /** The body's `error_domain` — `input`, `config` or `runtime` (see `ApiResponseError.errorDomain`). */
  errorDomain?: string;
  /** The body's `retryable` — whether retrying the same request can plausibly succeed. */
  retryable?: boolean;
  /** The body's `user_action` — what the caller should do next. */
  userAction?: UserAction;
}

/** The last constructor argument of `ApiResponseError`: the error's `cause`, and the parsed problem members. */
export interface ApiResponseErrorOptions {
  cause?: unknown;
  problem?: ProblemDetails;
}

/**
 * A non-2xx HTTP response that DID come back from the runner. Carries the raw
 * body, the message parsed out of it, and the typed members of its RFC 9457
 * problem document: the class (`type`, `title`, `errorType`), who can fix it
 * (`errorDomain`), whether a retry helps (`retryable`), what to do next
 * (`userAction`) and the id to hand to support (`requestId`). A member the
 * response did not carry is `undefined`.
 */
export class ApiResponseError extends PipelineRequestError {
  public readonly apiUrl: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  public readonly errorType: string | undefined;
  public readonly serverMessage: string | undefined;
  /**
   * RFC 9457 `type`: the stable URI naming the error class. With `errorDomain`,
   * the field a machine consumer branches on — the same class carries the same
   * URI on every occurrence.
   */
  public readonly type: string | undefined;
  /** RFC 9457 `title`: the short human label of the error class. */
  public readonly title: string | undefined;
  /** RFC 9457 `instance`: the occurrence — the request path, or a request URN. */
  public readonly instance: string | undefined;
  /**
   * The request's correlation id — the body's `request_id`, or the
   * `X-Request-ID` response header when the body carries none. The id to hand
   * to support: it finds the server's log lines for this request.
   */
  public readonly requestId: string | undefined;
  /**
   * The body's `error_domain`: who can fix the failure. `input` — the caller
   * (a malformed bundle, a bad argument, a missing input); `config` — the
   * runner's operator (a missing secret, a misconfigured backend); `runtime` —
   * nobody beforehand (a provider outage during execution). Typed open, as the
   * runner owns the vocabulary; `undefined` when the runner did not classify it.
   */
  public readonly errorDomain: string | undefined;
  /**
   * The body's `retryable`: whether retrying the same request can plausibly
   * succeed. `undefined` means unknown, which is not the same as `false`.
   */
  public readonly retryable: boolean | undefined;
  /** The body's `user_action`: what the caller should do next, when the runner can say. */
  public readonly userAction: UserAction | undefined;
  /**
   * Structured per-error diagnostics on a problem body that carries a top-level
   * `validation_errors[]` — the **run routes** (`POST /v1/execute`, `POST /v1/start`)
   * when a runner refuses to run an invalid method with a 422 instead of spending
   * anything on it.
   *
   * `POST /v1/validate` and the build routes (`POST /v1/build/*`) do not route content
   * errors here: an invalid bundle is a produced verdict (a **200** invalid arm whose
   * `validation_errors[]` the caller reads off the returned value), not an
   * `ApiResponseError`. This field is `undefined` for any error that carries no
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
    options?: ApiResponseErrorOptions,
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiResponseError";
    this.apiUrl = apiUrl;
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.errorType = errorType;
    this.serverMessage = serverMessage;
    this.validationErrors = validationErrors;
    const problem = options?.problem;
    this.type = problem?.type;
    this.title = problem?.title;
    this.instance = problem?.instance;
    this.requestId = problem?.requestId;
    this.errorDomain = problem?.errorDomain;
    this.retryable = problem?.retryable;
    this.userAction = problem?.userAction;
  }
}
