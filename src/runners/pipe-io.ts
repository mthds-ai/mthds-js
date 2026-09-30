/**
 * Reading a `/v1/pipe-io` answer: the one place both CLIs pick the descriptor of
 * the pipe the route selected, so their checks cannot drift apart.
 */

import type { PipeInputFormDescriptor } from "../protocol/input_form.js";
import type { PipeIOValidReport } from "./types.js";

/** A valid `/v1/pipe-io` answer that contradicts itself: it selected a pipe it does not describe. */
export class PipeIOAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipeIOAnswerError";
  }
}

/**
 * The input-form descriptor of the pipe a single-pipe `/v1/pipe-io` answer selected.
 *
 * The route keys `input_form` by exactly the ref it resolved, so a `null` ref or a
 * missing key is the answer contradicting itself; projecting any other descriptor
 * would template the wrong pipe.
 *
 * @throws {PipeIOAnswerError} The answer selected no pipe, or does not describe the one it selected.
 */
export function selectedInputDescriptor(report: PipeIOValidReport): {
  pipeRef: string;
  descriptor: PipeInputFormDescriptor;
} {
  const pipeRef = report.pipe_ref;
  const descriptor =
    pipeRef !== null && Object.hasOwn(report.input_form, pipeRef)
      ? report.input_form[pipeRef]
      : undefined;
  if (pipeRef === null || descriptor === undefined) {
    const described = Object.keys(report.input_form).join(", ") || "none";
    throw new PipeIOAnswerError(
      `The runner's pipe I/O answer selected ${pipeRef === null ? "no pipe" : `'${pipeRef}'`}, but its input_form does not describe it (it describes: ${described}).`,
    );
  }
  return { pipeRef, descriptor };
}
