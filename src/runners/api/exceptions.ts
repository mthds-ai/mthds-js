/**
 * The errors `MthdsApiClient` raises. Every one but `BlobUploadError` is a `ProblemError` carrying
 * a problem with a registered code (docs/errors.md), so a caller branches on `err.problem.code`,
 * and on `domain`, `retry` and `nextStep` when it handles several codes alike:
 *
 * - `ApiResponseError`: the runtime answered, and the answer is not the route's result: its
 *   problem document read as received, or the problem the client read the answer as when its body
 *   is not one (`client.response_unreadable`, or the one core code of its status);
 * - `RunStillRunningError`: a blocking execute was accepted asynchronously (`202`), so the run
 *   started and the client does not follow it (`client.follow_failed`);
 * - `ApiTransportError`: no answer came back: the runtime could not be reached
 *   (`client.unreachable`), the call ran out of time (`client.timeout`), or a request that creates
 *   a run left and its outcome is unknown (`client.outcome_unknown`);
 * - `MalformedBlobsAnswerError`: `POST /blobs/missing` answered a success whose body is not
 *   shaped as the protocol says (`client.response_unreadable`), quoting none of it, since its
 *   upload URLs are bearer capabilities.
 *
 * An argument the client refuses before any request leaves is a `ProblemError` of
 * `client.argument_invalid` or `client.not_configured`. A failed upload of a blob to the target
 * `POST /blobs/missing` named is a `BlobUploadError`, which carries no problem yet. Mirrors
 * `mthds/runners/api/exceptions.py`.
 */

import { PipelineRequestError } from "../../protocol/exceptions.js";
import { ProblemError, problemSentence } from "../../problems/errors.js";
import { buildProblem } from "../../problems/build.js";
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

/** How much of a body that is no problem document an error's message quotes, as the Python twin does. */
export const BODY_EXCERPT_LENGTH = 500;

/** The start of a body, its whitespace collapsed, as an error's message quotes it. */
function bodyExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > BODY_EXCERPT_LENGTH ? `${flat.slice(0, BODY_EXCERPT_LENGTH)}…` : flat;
}

/**
 * An answer of the runtime that is not the route's result, read as its problem. Its message names
 * the route and the status, then the problem's sentence, and ends with its next step. For a body
 * that is no problem document, the start of the body, which is the runtime's text and never a
 * problem member, is quoted on its own line between them, and the next step takes the last line.
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
    const head = `${facts.route} failed (${facts.status}): `;
    if (facts.bodyIsProblem === false && facts.responseBody.trim() !== "") {
      const step = problem.next_step.detail;
      this.message =
        `${head}${problemSentence(problem)}\nThe server answered: ${bodyExcerpt(facts.responseBody)}` +
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

/**
 * Thrown when uploading a blob to the target `POST /blobs/missing` named fails: the
 * target answered neither a success nor a `412` (the bytes are already held), or it
 * could not be reached. The target URL is a bearer capability, so neither the message
 * nor any member carries it; `host` names where the upload went. The target may be
 * another server than the runtime, such as an object store behind a signed URL, whose
 * answer is no problem document, so this error carries no problem.
 */
export class BlobUploadError extends PipelineRequestError {
  /** The SHA-256 of the blob, in lowercase hexadecimal. */
  public readonly sha256: string;
  /** The status the target answered, or `undefined` when it could not be reached. */
  public readonly status: number | undefined;
  /** The host of the upload target. */
  public readonly host: string;

  constructor(
    message: string,
    sha256: string,
    status: number | undefined,
    host: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BlobUploadError";
    this.sha256 = sha256;
    this.status = status;
    this.host = host;
  }
}

/**
 * Thrown when a runner's success answer to `POST /blobs/missing` is not shaped as the protocol
 * says: a body that is not JSON, no `missing` list, or an entry that is not a missing blob with a
 * well-formed upload target. It reads as `client.response_unreadable`, naming the answer's status,
 * as any success that is not its route's result does. No upload was started and no request
 * carrying the tree was sent. An entry's upload URL is a bearer capability, so neither the message
 * nor any member quotes the body.
 */
export class MalformedBlobsAnswerError extends ProblemError {
  /** The position of the faulty entry in `missing`, or `undefined` when the answer as a whole is malformed. */
  public readonly index: number | undefined;
  /** The faulty entry's SHA-256 when it carries a well-formed one, else `undefined`. */
  public readonly sha256: string | undefined;

  constructor(message: string, status: number, index?: number, sha256?: string) {
    super(buildProblem("client.response_unreadable", { status }, { extra: { message } }));
    this.name = "MalformedBlobsAnswerError";
    this.index = index;
    this.sha256 = sha256;
  }
}
