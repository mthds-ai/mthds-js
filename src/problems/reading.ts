/**
 * The readers' fallbacks (mthds/docs/spec/protocol.md, "Readers and emitters"). A problem keeps
 * the values it was received with; these functions read them into the closed lists:
 *
 * - a domain or a step kind this reader does not know reads by the code's family, as the codes of
 *   that family this reader knows read, and when it knows nothing of the family either, as the
 *   domain `runtime` and the step `report`;
 * - a `retry` it does not know reads as `no`, so that nothing is repeated on a guess;
 * - an item carries no domain, so its domain is its code's, read the same way;
 * - a `safety` it does not know reads as `unsafe`, and a fix holding an operation of a kind it does
 *   not know is applied not at all.
 *
 * Reading by the family takes the value every code of the family this reader knows shares. A
 * family whose codes disagree, such as `request`, where most codes are the caller's and one is
 * the runtime's, says nothing this reader can rely on, so it reads as a family it knows nothing of.
 */

import {
  FIX_OP_KINDS,
  FIX_SAFETIES,
  PROBLEM_DOMAINS,
  RETRY_VERDICTS,
  STEP_KINDS,
} from "./vocabulary.js";
import type { FixSafety, ProblemDomain, RetryVerdict, StepKind } from "./vocabulary.js";
import type { FixOp, KnownFixOp, SuggestedFix } from "./types.js";
import { codeFamily, familyEntries, registryEntry } from "./registry.js";

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The one value every element shares, or `undefined` when there is none or they disagree. */
function shared<T>(values: readonly T[]): T | undefined {
  if (values.length === 0) return undefined;
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

/** The domain the codes of `code`'s family share, when this reader knows the family and they agree. */
function familyDomain(code: string): ProblemDomain | undefined {
  return shared(familyEntries(codeFamily(code)).map((entry) => entry.domain));
}

/** The step kind the codes of `code`'s family share, for either reader, when they agree. */
function familyStepKind(code: string): StepKind | undefined {
  return shared(
    familyEntries(codeFamily(code)).flatMap((entry) => [
      entry.steps.actor.kind,
      entry.steps.other.kind,
    ]),
  );
}

/**
 * Who must act on a problem, when this reader can tell: its `domain` when this reader knows it,
 * else the one its code's family's known codes share, else `undefined`.
 */
export function knownProblemDomain(problem: {
  code: string;
  domain: string;
}): ProblemDomain | undefined {
  if (isOneOf(PROBLEM_DOMAINS, problem.domain)) return problem.domain;
  return familyDomain(problem.code);
}

/** Who must act on a problem: its `domain` when this reader knows it, else its code's family's, else `runtime`. */
export function problemDomain(problem: { code: string; domain: string }): ProblemDomain {
  return knownProblemDomain(problem) ?? "runtime";
}

/** Whether a repeat can succeed: the problem's `retry` when this reader knows it, else `no`. */
export function problemRetry(problem: { retry: string }): RetryVerdict {
  return isOneOf(RETRY_VERDICTS, problem.retry) ? problem.retry : "no";
}

/** What to do next: the problem's step kind when this reader knows it, else its code's family's, else `report`. */
export function problemStepKind(problem: { code: string; next_step: { kind: string } }): StepKind {
  if (isOneOf(STEP_KINDS, problem.next_step.kind)) return problem.next_step.kind;
  return familyStepKind(problem.code) ?? "report";
}

/**
 * Who must act on an item, which carries no domain of its own: its code's, when the core registry
 * declares the code, else its code's family's, else `runtime`.
 */
export function itemDomain(item: { code: string }): ProblemDomain {
  return registryEntry(item.code)?.domain ?? familyDomain(item.code) ?? "runtime";
}

/** Whether a suggested fix may be applied without asking: its `safety` when this reader knows it, else `unsafe`. */
export function fixSafety(fix: { safety: string }): FixSafety {
  return isOneOf(FIX_SAFETIES, fix.safety) ? fix.safety : "unsafe";
}

/** Whether a fix operation is of a kind the protocol lists, so its members can be read. */
export function isKnownFixOp(op: FixOp): op is KnownFixOp {
  return isOneOf(FIX_OP_KINDS, op.kind);
}

/** Whether an applier may apply a fix: every operation of it is of a kind it knows. */
export function isApplicableFix(fix: SuggestedFix): boolean {
  return fix.ops.every(isKnownFixOp);
}
