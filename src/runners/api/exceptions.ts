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

import { ProblemError, problemSentence } from "../../problems/errors.js";
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
   * Whether the body is the problem document the error carries. When it is not, the error quotes
   * the start of the body (`answerExcerpt`), which no member of the problem ever holds.
   */
  bodyIsProblem?: boolean;
}

/** How much of a body that is no problem document an error quotes, as the Python twin does. */
export const BODY_EXCERPT_LENGTH = 500;

/**
 * A URL written in a body: its scheme and `//`, the slashes written as they are or escaped as JSON
 * may escape them (`https:\/\/`), then everything up to a space, a quote or an angle bracket.
 */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)[^\s"'<>`]*/gi;
/** The scheme and `//` of a URL, then its userinfo, which ends at an `@` before the path. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/))[^/\\@?#]*@/i;

/**
 * A URL without anything in it that may grant access: its query and its fragment, where a
 * presigned URL carries its signature, and its userinfo, a credential. Its scheme, host, port and
 * path are kept, as the Python twin's `url_without_credentials` keeps them.
 */
function urlShown(url: string): string {
  const end = url.search(/[?#]/);
  const beforeQuery = end === -1 ? url : url.slice(0, end);
  return beforeQuery.replace(URL_USERINFO, "$1");
}

/**
 * The start of an answer's body as an error quotes it, for a person: its whitespace collapsed,
 * every URL in it without its query, its fragment and its userinfo (`urlShown`), and cut at
 * `BODY_EXCERPT_LENGTH` characters with an ellipsis. `undefined` when the body is empty.
 */
export function bodyExcerpt(body: string): string | undefined {
  const flat = body.replace(/\s+/g, " ").trim().replace(URL_IN_TEXT, urlShown);
  if (flat === "") return undefined;
  return flat.length > BODY_EXCERPT_LENGTH ? `${flat.slice(0, BODY_EXCERPT_LENGTH)}…` : flat;
}

/**
 * An answer of the runtime that is not the route's result, read as its problem. Its message names
 * the route and the status, then the problem's sentence, and ends with its next step. For a body
 * that is no problem document, the start of the body (`answerExcerpt`), which is the runtime's text
 * and never a problem member, is quoted on its own line between them, and the next step takes the
 * last line.
 */
export class ApiResponseError extends ProblemError {
  public readonly apiUrl: string;
  public readonly route: string;
  /** The answer's HTTP status, whatever the problem's own `status` member says. */
  public readonly status: number;
  public readonly statusText: string;
  /** The answer's body, as received. It is never quoted whole. */
  public readonly responseBody: string;
  /**
   * What the server said, for a person: the start of a body that is no problem document, as
   * `bodyExcerpt` cuts it, every URL without its query. `undefined` when the body is the problem
   * the error carries or is empty. The message quotes it, and so do both CLIs.
   */
  public readonly answerExcerpt: string | undefined;
  private readonly requestIdHeader: string | undefined;

  constructor(problem: Problem, facts: ApiAnswerFacts, options?: { cause?: unknown }) {
    super(problem, options);
    this.name = "ApiResponseError";
    this.answerExcerpt =
      facts.bodyIsProblem === false ? bodyExcerpt(facts.responseBody) : undefined;
    const head = `${facts.route} failed (${facts.status}): `;
    if (this.answerExcerpt !== undefined) {
      const step = problem.next_step.detail;
      this.message =
        `${head}${problemSentence(problem)}\nThe server answered: ${this.answerExcerpt}` +
        (step.length > 0 ? `\nNext step: ${step}` : "");
    } else {
      this.message = `${head}${this.message}`;
    }
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
 * What an answer of the runtime said beside its problem, which no member of the problem holds: the
 * route that answered, its status, and the start of its body when the body is no problem document.
 */
export interface ServerAnswer {
  /** The route that answered, as `POST /v1/execute`. */
  route: string;
  /** The answer's HTTP status. */
  status: number;
  /** The answer's status text, empty when the transport gives none. */
  statusText: string;
  /** The start of a body that is no problem document (`ApiResponseError.answerExcerpt`). */
  excerpt?: string;
}

/**
 * What the server answered beside an error's problem, for an `ApiResponseError`, and `undefined`
 * for any other error. The one reading both CLIs format, each in its own form.
 */
export function serverAnswerOf(err: unknown): ServerAnswer | undefined {
  if (!(err instanceof ApiResponseError)) return undefined;
  const answer: ServerAnswer = { route: err.route, status: err.status, statusText: err.statusText };
  if (err.answerExcerpt !== undefined) answer.excerpt = err.answerExcerpt;
  return answer;
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
