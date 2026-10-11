/**
 * What a command's own code tells the usage statistics about how it ended, beyond its exit code.
 *
 * A leaf module with no import, so that the output helpers (`agentError`) and the passthrough can
 * note a failure's domain, an interrupt or JSON written to stderr without depending on the
 * statistics machinery.
 */

import type { ErrorDomain } from "./contract.js";

interface OutcomeNotes {
  errorDomain?: ErrorDomain;
  cancelled: boolean;
  /** Whether the command wrote JSON to stderr, which makes it a stream a program reads. */
  jsonOnStderr: boolean;
}

const notes: OutcomeNotes = { cancelled: false, jsonOnStderr: false };

/** Record who can fix the error the command is failing with; the first note wins. */
export function noteErrorDomain(domain: ErrorDomain | undefined): void {
  if (domain !== undefined && notes.errorDomain === undefined) notes.errorDomain = domain;
}

/** Record that the command ends because the person interrupted it. */
export function noteCancelled(): void {
  notes.cancelled = true;
}

/**
 * Record that the command wrote JSON to stderr, an error document or a warning line: a program
 * reads that stream, so the notice must stay off it.
 */
export function noteJsonOnStderr(): void {
  notes.jsonOnStderr = true;
}

export function outcomeNotes(): Readonly<OutcomeNotes> {
  return notes;
}

/** Forget every note: for tests, which run several commands in one process. */
export function resetOutcomeNotes(): void {
  notes.errorDomain = undefined;
  notes.cancelled = false;
  notes.jsonOnStderr = false;
}
