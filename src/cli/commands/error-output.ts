/**
 * What the `mthds` CLI prints for a failure: the problem's plain-line rendering
 * (`renderProblemLines`), which states its title and detail, the command's own sentence, the next
 * step, the code with its domain and retry verdict, the request id and the run when it names
 * them (the request id of the answer's header when the problem names none), and every item of its
 * `errors` with its suggested fix. For an answer of the runtime that is not the route's result, the
 * route and the status come before the next step, and so does what the server said when the body
 * is no problem document, which no member of the problem holds. Every error the runners and the
 * client raise carries a problem; any other error prints its message alone.
 */

import { ProblemError, reportedProblem } from "../../problems/errors.js";
import { formatItem, formatSuggestedFix, renderProblemLines } from "../../problems/render.js";
import { CORE_REGISTRY } from "../../problems/registry.generated.js";
import type { ProblemItem } from "../../problems/types.js";
import { ApiResponseError } from "../../runners/api/exceptions.js";

/** The text the `mthds` CLI prints for a failed command. */
export function formatCliError(err: unknown): string {
  if (err instanceof ProblemError) {
    return renderProblemLines(reportedProblem(err), answerLines(err)).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * What an answer of the runtime says beside its problem: the route that answered and its status,
 * then the start of its body when the body is no problem document (`answerExcerpt`), as the error's
 * own message quotes it. Nothing for an error that is no answer.
 */
function answerLines(err: ProblemError): string[] {
  if (!(err instanceof ApiResponseError)) return [];
  const status = err.statusText ? `${err.status} ${err.statusText}` : `${err.status}`;
  const lines = [`${err.route} failed (${status}).`];
  if (err.answerExcerpt !== undefined) lines.push(`The server answered: ${err.answerExcerpt}`);
  return lines;
}

/** The sentence an invalid verdict opens with: its own `message`, else the title of `method.invalid`. */
export function verdictSummary(message: string | undefined): string {
  return message ?? CORE_REGISTRY["method.invalid"].title;
}

/**
 * One item of a verdict as list lines: `- <code>: <detail> (<location>)`, then its suggested
 * fix indented two spaces past it when it has one. It is the one way the `mthds` CLI prints an
 * item, in `validate`, `build` and `install`, so each reads the same as in a refusal's rendering.
 */
export function formatItemLines(item: ProblemItem, indent = ""): string[] {
  const lines = [`${indent}- ${formatItem(item)}`];
  if (item.suggested_fix !== undefined) {
    lines.push(`${indent}  ${formatSuggestedFix(item.suggested_fix)}`);
  }
  return lines;
}
