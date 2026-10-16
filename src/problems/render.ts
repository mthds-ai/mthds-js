/**
 * Renderings of a problem for a person or an agent: Markdown, for the error stream of
 * `mthds-agent` (mthds/docs/spec/cli-io-contract.md, "Error Propagation"), and plain lines, for
 * the `mthds` CLI. Both state the title, the detail, the next step and the code, then the request
 * id and the run when the problem names them, and every item of its `errors`. A rendering is
 * presentation: a program reads the problem's JSON form and branches on its `code`.
 */

import { fixSafety, problemDomain, problemRetry } from "./reading.js";
import type { Problem, ProblemItem, ProblemLocation, SuggestedFix } from "./types.js";

/** The request id a problem names: a runtime's own `request_id` member, which the protocol does not declare. */
export function problemRequestId(problem: Problem): string | undefined {
  const id = problem.request_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** The command's own sentence a client-built problem may carry beside its detail, in its `message` member. */
function problemMessage(problem: Problem): string | undefined {
  const message = problem.message;
  return typeof message === "string" && message.length > 0 && message !== problem.detail
    ? message
    : undefined;
}

/** Where a fault happened, in words: `pipe 'summarize', file 'contracts.mthds', line 12`. */
export function formatLocation(location: ProblemLocation | undefined): string {
  if (location === undefined) return "";
  const parts: string[] = [];
  if (typeof location.pipe === "string") parts.push(`pipe '${location.pipe}'`);
  if (Array.isArray(location.path) && location.path.length > 0) {
    parts.push(`path ${location.path.join(" > ")}`);
  }
  if (typeof location.input === "string") parts.push(`input '${location.input}'`);
  if (typeof location.field === "string") parts.push(`field '${location.field}'`);
  if (typeof location.item === "number") parts.push(`item ${location.item}`);
  if (typeof location.attempt === "number") parts.push(`attempt ${location.attempt}`);
  if (typeof location.file === "string") parts.push(`file '${location.file}'`);
  if (typeof location.line === "number") parts.push(`line ${location.line}`);
  if (typeof location.column === "number") parts.push(`column ${location.column}`);
  return parts.join(", ");
}

/** A suggested fix in one line: its description, its safety and the rule that produced it. */
export function formatSuggestedFix(fix: SuggestedFix): string {
  return `Suggested fix (${fixSafety(fix)}, ${fix.fix_code}): ${fix.description}`;
}

/** One item of a problem or a verdict in one line: its code, its detail and where it happened. */
export function formatItem(item: ProblemItem): string {
  const where = formatLocation(item.location);
  return `${item.code}: ${item.detail}${where ? ` (${where})` : ""}`;
}

/** The facts a rendering states after the problem's sentences: its code, verdict, request id and run. */
function factLines(problem: Problem, code: (text: string) => string): string[] {
  const verdict = [`domain ${problemDomain(problem)}`, `retry ${problemRetry(problem)}`];
  if (typeof problem.retry_after === "number") verdict.push(`after ${problem.retry_after} seconds`);
  const lines = [`Code: ${code(problem.code)} (${verdict.join(", ")})`];
  const requestId = problemRequestId(problem);
  if (requestId !== undefined) lines.push(`Request id: ${code(requestId)}`);
  if (problem.pipeline_run_id !== undefined) lines.push(`Run: ${code(problem.pipeline_run_id)}`);
  const where = formatLocation(problem.location);
  if (where) lines.push(`Location: ${where}`);
  return lines;
}

/** A problem rendered as Markdown, for an agent: the error stream of `mthds-agent` by default. */
export function renderProblemMarkdown(problem: Problem): string {
  const tick = (text: string): string => `\`${text}\``;
  const lines = [`## ${problem.title}`, "", problem.detail];
  const message = problemMessage(problem);
  if (message !== undefined) lines.push("", message);
  lines.push(
    "",
    `**Next step** (${tick(problem.next_step.kind)}): ${problem.next_step.detail}`,
    "",
  );
  lines.push(...factLines(problem, tick).map((line) => `- ${line}`));
  if (problem.errors !== undefined && problem.errors.length > 0) {
    lines.push("", "### Errors", "");
    for (const item of problem.errors) {
      const where = formatLocation(item.location);
      lines.push(`- ${tick(item.code)}: ${item.detail}${where ? ` (${where})` : ""}`);
      if (item.suggested_fix !== undefined) {
        lines.push(`  - ${formatSuggestedFix(item.suggested_fix)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A problem rendered as plain lines, for a person: what the `mthds` CLI prints. */
export function renderProblemLines(problem: Problem): string[] {
  const lines = [`${problem.title}: ${problem.detail}`];
  const message = problemMessage(problem);
  if (message !== undefined) lines.push(message);
  lines.push(`Next step: ${problem.next_step.detail}`);
  lines.push(...factLines(problem, (text) => text));
  for (const item of problem.errors ?? []) {
    lines.push(`- ${formatItem(item)}`);
    if (item.suggested_fix !== undefined) lines.push(`  ${formatSuggestedFix(item.suggested_fix)}`);
  }
  return lines;
}
