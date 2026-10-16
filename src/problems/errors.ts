/**
 * The error that carries a problem. Every error `MthdsApiClient` raises is a `ProblemError`, and
 * so is every refusal of an argument the protocol surface checks before any request leaves, so a
 * caller reads every failure alike: by `problem.code`, and by `domain`, `retry` and `nextStep`
 * when it handles several codes alike.
 */

import { PipelineRequestError } from "../protocol/exceptions.js";
import { problemDomain, problemRetry, problemStepKind } from "./reading.js";
import { buildProblem } from "./build.js";
import { problemRequestId } from "./render.js";
import type { CoreErrorCode, ProblemParamsByCode } from "./registry.generated.js";
import type { StepReader } from "./build.js";
import type { NextStep, Problem } from "./types.js";
import type { ProblemDomain, RetryVerdict, StepKind } from "./vocabulary.js";

/**
 * The message of an error carrying `problem`: the problem's `message` member when it carries one,
 * the caller's own sentence for a refusal it built, else its `detail`, then its next step, so that
 * a reader of the message alone learns what to do.
 */
export function problemErrorMessage(problem: Problem): string {
  const sentence =
    typeof problem.message === "string" && problem.message.length > 0
      ? problem.message
      : problem.detail;
  const step = problem.next_step.detail;
  return step.length > 0 && !sentence.includes(step) ? `${sentence} ${step}` : sentence;
}

/**
 * An error carrying the problem that describes it. Its message is `problemErrorMessage`'s: the
 * problem's own sentence, then its next step.
 */
export class ProblemError extends PipelineRequestError {
  /** The problem, as received from the runtime or as the client built it. */
  public readonly problem: Problem;

  constructor(problem: Problem, options?: { cause?: unknown }) {
    super(problemErrorMessage(problem), options);
    this.name = "ProblemError";
    this.problem = problem;
  }

  /** The problem's code, the member a caller branches on. */
  get code(): string {
    return this.problem.code;
  }

  /** Who must act, read into the closed list (`problemDomain`). */
  get domain(): ProblemDomain {
    return problemDomain(this.problem);
  }

  /** Whether a repeat can succeed, read into the closed list (`problemRetry`): never repeat on `outcome_unknown`. */
  get retry(): RetryVerdict {
    return problemRetry(this.problem);
  }

  /** The next step as received, its kind read into the closed list. */
  get nextStep(): NextStep & { kind: StepKind } {
    return { ...this.problem.next_step, kind: problemStepKind(this.problem) };
  }

  /** Seconds to wait before a repeat, when the problem gives them. */
  get retryAfter(): number | undefined {
    return this.problem.retry_after;
  }

  /** The runtime's id for the request that failed, to hand to whoever runs it. */
  get requestId(): string | undefined {
    return problemRequestId(this.problem);
  }
}

/**
 * The problem an error reports: its problem, with the request id the error knows written beside it
 * when the problem names none, such as the `X-Request-ID` header of the answer an
 * `ApiResponseError` read. The problem itself stays as received.
 */
export function reportedProblem(err: ProblemError): Problem {
  const requestId = err.requestId;
  if (requestId === undefined || problemRequestId(err.problem) !== undefined) return err.problem;
  return { ...err.problem, request_id: requestId };
}

/** Whether `err` carries a problem. */
export function isProblemError(err: unknown): err is ProblemError {
  return err instanceof ProblemError;
}

/** What `problemError` may add to the problem it builds. */
export interface ProblemErrorOptions {
  /** The caller's own sentence, kept in the problem's `message` member beside the registry's detail. */
  message?: string;
  cause?: unknown;
  /** Which of the code's steps the problem carries; by default, the one for the client's own caller. */
  reader?: StepReader;
}

/** A `ProblemError` of a core code the client raises itself, built from the registry. */
export function problemError<Code extends CoreErrorCode>(
  code: Code,
  params: ProblemParamsByCode[Code],
  options: ProblemErrorOptions = {},
): ProblemError {
  return new ProblemError(
    buildProblem(code, params, { reader: options.reader, extra: { message: options.message } }),
    options.cause === undefined ? undefined : { cause: options.cause },
  );
}

/**
 * The refusal of an argument before any request left, `client.argument_invalid`: `argument` names
 * it, `reason` says why in one identifier, and `message` is the caller's own sentence, kept in the
 * problem's `message` member beside the registry's detail.
 */
export function argumentInvalid(argument: string, reason: string, message?: string): ProblemError {
  return problemError("client.argument_invalid", { argument, reason }, { message });
}
