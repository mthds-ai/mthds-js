/**
 * What a command's own code tells the usage statistics about how it ended, beyond its exit code.
 *
 * A module importing only the problem readers, so that the output helpers (`agentError`) and the
 * passthrough can note a failure's problem or an interrupt without depending on the statistics
 * machinery.
 */

import type { ErrorDomain } from "./contract.js";
import { problemDomain } from "../problems/reading.js";
import type { ProblemDomain } from "../problems/vocabulary.js";

interface OutcomeNotes {
  errorDomain?: ErrorDomain;
  cancelled: boolean;
}

const notes: OutcomeNotes = { cancelled: false };

/** Record who can fix the error the command is failing with; the first note wins. */
export function noteErrorDomain(domain: ErrorDomain | undefined): void {
  if (domain !== undefined && notes.errorDomain === undefined) notes.errorDomain = domain;
}

/**
 * The contract's `error_domain` of a problem's domain: the caller fixes an `input` or a `method`
 * problem, the machine's or the account's setup an `account` or an `operator` one, and nobody
 * beforehand a `runtime` one, a domain this reader does not know read by the code's family. The
 * contract has no member for the problem's code yet, so its domain is what the event carries.
 */
const ERROR_DOMAIN_OF_PROBLEM_DOMAIN: Readonly<Record<ProblemDomain, ErrorDomain>> = {
  input: "input",
  method: "input",
  account: "config",
  operator: "config",
  runtime: "runtime",
};

/** Record who can fix the problem the command is failing with; the first note wins. */
export function noteProblem(problem: { code: string; domain: string }): void {
  noteErrorDomain(ERROR_DOMAIN_OF_PROBLEM_DOMAIN[problemDomain(problem)]);
}

/** Record that the command ends because the person interrupted it. */
export function noteCancelled(): void {
  notes.cancelled = true;
}

export function outcomeNotes(): Readonly<OutcomeNotes> {
  return notes;
}

/** Forget every note: for tests, which run several commands in one process. */
export function resetOutcomeNotes(): void {
  notes.errorDomain = undefined;
  notes.cancelled = false;
}
