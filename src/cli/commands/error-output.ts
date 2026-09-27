import { ApiResponseError } from "../../runners/api/exceptions.js";

/**
 * How the `mthds` CLI reads each `error_domain` of a runner's problem document
 * to the person at the terminal: whose move the fix is.
 */
const ERROR_DOMAIN_READINGS: Record<string, string> = {
  input: "the request must change",
  config: "the runner's configuration must change, not the request",
  runtime: "a failure on the runner's side, not in the request",
};

/**
 * The text the `mthds` CLI prints for a failed command: the error's message
 * and, when a runner answered with a problem document, what it said about the
 * failure — the validation items of a refusal that lists them (a run route
 * refusing an invalid method), each with its locators and suggested fix, then
 * who can fix it (the error domain), the next step, whether a retry can
 * succeed, and the request id to quote to support. A member the runner did not
 * send prints nothing; any error other than an `ApiResponseError` prints its
 * message alone.
 */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ApiResponseError)) return message;
  const lines = [message];
  // The items come off the wire, so a version-skewed payload may hold anything:
  // keep only real objects, as the Codex hook does with its envelope.
  const items: unknown[] = Array.isArray(err.validationErrors) ? err.validationErrors : [];
  for (const item of items) {
    if (typeof item === "object" && item !== null) lines.push(formatValidationItem(item));
  }
  if (err.errorDomain) {
    const reading = ERROR_DOMAIN_READINGS[err.errorDomain];
    lines.push(`Error domain: ${err.errorDomain}${reading ? ` (${reading})` : ""}`);
  }
  if (err.userAction) lines.push(`Next step: ${err.userAction.detail}`);
  if (err.retryable !== undefined) lines.push(`Retryable: ${err.retryable ? "yes" : "no"}`);
  if (err.requestId) lines.push(`Request id: ${err.requestId} (quote it to support)`);
  return lines.join("\n");
}

/** The locators a printed validation item names, in order, each with its label. */
const ITEM_LOCATORS: ReadonlyArray<readonly [string, string]> = [
  ["pipe_code", "pipe"],
  ["concept_code", "concept"],
  ["domain_code", "domain"],
  ["field_name", "field"],
  ["missing_pipe_code", "missing pipe"],
  ["missing_concept_code", "missing concept"],
  ["source", "source"],
];

/**
 * One validation item as a list line: `- [<category>] <message> (<locators>)`, the
 * locators being the pipe, concept, domain, field, missing pipe or concept and source
 * the item carries, followed by its suggested fix when it has one ({@link withSuggestedFix}).
 * It is the one way a list of items is printed — the `mthds` CLI's refusal of a run and
 * the Codex hook's blocking reason — so the person and the agent read the same item.
 *
 * The item is read loosely, as it may come from a version-skewed payload: a field the
 * item does not carry is left out, and any other value prints as it came.
 */
export function formatValidationItem(item: object): string {
  const fields = item as Record<string, unknown>;
  const locators = ITEM_LOCATORS.filter(([key]) => fields[key])
    .map(([key, label]) => `${label}: ${String(fields[key])}`)
    .join(", ");
  const category = fields.category ? `[${String(fields.category)}] ` : "";
  const message = String(fields.message ?? "");
  return withSuggestedFix(`- ${category}${message}${locators ? ` (${locators})` : ""}`, item);
}

/**
 * A printed validation item followed by its suggested fix: the item's `line`, then
 * `Suggested fix: <description>` indented two spaces past it, when the item carries a
 * `suggested_fix` with a description. It is the one way every surface prints a fix
 * under an item — the `mthds` CLI's `validate`, `build`, `install` and `run`, and the
 * Codex hook's blocking reason — so the person and the agent read the same next step.
 *
 * The item is read defensively, as it may come from a version-skewed payload: an item
 * with no fix, a `suggested_fix` that is not an object, or a description that is not a
 * non-blank string leaves the line alone.
 */
export function withSuggestedFix(line: string, item: unknown): string {
  const description = suggestedFixDescription(item);
  if (!description) return line;
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  return `${line}\n${indent}  Suggested fix: ${description}`;
}

function suggestedFixDescription(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const fix = (item as { suggested_fix?: unknown }).suggested_fix;
  if (!fix || typeof fix !== "object") return undefined;
  const description = (fix as { description?: unknown }).description;
  return typeof description === "string" && description.trim() ? description.trim() : undefined;
}
