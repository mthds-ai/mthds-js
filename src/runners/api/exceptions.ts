/**
 * The errors `MthdsApiClient` raises. Every one is a `ProblemError` carrying a problem with a
 * registered code (docs/errors.md), so a caller branches on `err.problem.code`, and on `domain`,
 * `retry` and `nextStep` when it handles several codes alike:
 *
 * - `ApiResponseError`: the runtime answered, and the answer is not the route's result: its
 *   problem document read as received, or the problem the client read the answer as when its body
 *   is not one (`client.response_unreadable`, or the one core code of its status);
 * - `RunStillRunningError`: a blocking execute was accepted asynchronously (`202`), so the run
 *   started and the client does not follow it (`client.follow_failed`);
 * - `ApiTransportError`: no answer came back: the runtime could not be reached
 *   (`client.unreachable`), the call ran out of time (`client.timeout`), or a request that creates
 *   a run left and its outcome is unknown (`client.outcome_unknown`).
 *
 * An argument the client refuses before any request leaves is a `ProblemError` of
 * `client.argument_invalid` or `client.not_configured`. Mirrors `mthds/runners/api/exceptions.py`.
 */

import { ProblemError } from "../../problems/errors.js";
import type { Problem } from "../../problems/types.js";

export { PipelineRequestError } from "../../protocol/exceptions.js";
export { ProblemError };

/** What an `ApiResponseError` knows of the answer beside its problem. */
export interface ApiAnswerFacts {
  /** The base URL the client is configured with. */
  apiUrl: string;
  /** The route that answered, as `POST /v1/execute`. */
  route: string;
  /** The answer's HTTP status. */
  status: number;
  statusText: string;
  /** The answer's body, as received. */
  responseBody: string;
  /** The answer's `X-Request-ID` header, the fallback for a problem that names no `request_id`. */
  requestIdHeader?: string;
  /**
   * Whether the body is the problem document the error carries. When it is not, the message
   * quotes the start of the body, which no member of the problem ever holds.
   */
  bodyIsProblem?: boolean;
}

/** How much of a body that is no problem document an error's message quotes. */
export const BODY_EXCERPT_LENGTH = 300;

/** The start of a body, its whitespace collapsed, as an error's message quotes it. */
function bodyExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > BODY_EXCERPT_LENGTH ? `${flat.slice(0, BODY_EXCERPT_LENGTH)}…` : flat;
}

/**
 * An answer of the runtime that is not the route's result, read as its problem. Its message names
 * the route and the status, then the problem's sentence and next step, and, for a body that is no
 * problem document, the start of the body, which is the runtime's text and never a problem member.
 */
export class ApiResponseError extends ProblemError {
  public readonly apiUrl: string;
  public readonly route: string;
  /** The answer's HTTP status, whatever the problem's own `status` member says. */
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody: string;
  private readonly requestIdHeader: string | undefined;

  constructor(problem: Problem, facts: ApiAnswerFacts, options?: { cause?: unknown }) {
    super(problem, options);
    this.name = "ApiResponseError";
    const excerpt =
      facts.bodyIsProblem === false && facts.responseBody.trim() !== ""
        ? ` The answer's body begins: ${bodyExcerpt(facts.responseBody)}`
        : "";
    this.message = `${facts.route} failed (${facts.status}): ${this.message}${excerpt}`;
    this.apiUrl = facts.apiUrl;
    this.route = facts.route;
    this.status = facts.status;
    this.statusText = facts.statusText;
    this.responseBody = facts.responseBody;
    this.requestIdHeader = facts.requestIdHeader;
  }

  /** The request's id: the problem's `request_id`, else the answer's `X-Request-ID` header. */
  override get requestId(): string | undefined {
    return super.requestId ?? this.requestIdHeader;
  }
}

/**
 * A blocking execute that the runtime accepted asynchronously: the protocol lets a runner answer
 * `/execute` with `202` and the run's id when it cannot hold the connection open. The run keeps
 * going, and this client does not follow it: read it by `runId`, with the durable run API of the
 * runtime's own SDK, or at `location` when the answer gives one.
 */
export class RunStillRunningError extends ApiResponseError {
  public readonly runId: string;
  /** The answer's `Retry-After`, in seconds, when it gives one. */
  public readonly retryAfterSeconds: number | undefined;
  /** The answer's `Location` header, the run's status resource, when it gives one. */
  public readonly location: string | undefined;

  constructor(
    problem: Problem,
    facts: ApiAnswerFacts & { runId: string; retryAfterSeconds?: number; location?: string },
  ) {
    super(problem, facts);
    this.name = "RunStillRunningError";
    this.runId = facts.runId;
    this.retryAfterSeconds = facts.retryAfterSeconds;
    this.location = facts.location;
  }
}

/**
 * A call that got no answer: the runtime could not be reached, the call ran out of time, or the
 * connection was lost. `cause` is what fetch threw.
 */
export class ApiTransportError extends ProblemError {
  public readonly apiUrl: string;
  /** The network code of the failure, such as `ECONNREFUSED`, when it carries one. */
  public readonly networkCode: string | undefined;

  constructor(
    problem: Problem,
    facts: { apiUrl: string; networkCode?: string },
    options?: { cause?: unknown },
  ) {
    super(problem, options);
    this.name = "ApiTransportError";
    this.apiUrl = facts.apiUrl;
    this.networkCode = facts.networkCode;
  }
}
