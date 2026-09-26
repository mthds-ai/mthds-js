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
 * failure — who can fix it (the error domain), the next step, whether a retry
 * can succeed, and the request id to quote to support. A member the runner did
 * not send prints nothing; any error other than an `ApiResponseError` prints its
 * message alone.
 */
export function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ApiResponseError)) return message;
  const lines = [message];
  if (err.errorDomain) {
    const reading = ERROR_DOMAIN_READINGS[err.errorDomain];
    lines.push(`Error domain: ${err.errorDomain}${reading ? ` (${reading})` : ""}`);
  }
  if (err.userAction) lines.push(`Next step: ${err.userAction.detail}`);
  if (err.retryable !== undefined) lines.push(`Retryable: ${err.retryable ? "yes" : "no"}`);
  if (err.requestId) lines.push(`Request id: ${err.requestId} (quote it to support)`);
  return lines.join("\n");
}

/**
 * A printed validation item followed by its suggested fix: the item's `line`, then
 * `Suggested fix: <description>` indented two spaces past it, when the item carries a
 * `suggested_fix` with a description. It is the one way every surface prints a fix
 * under an item — the `mthds` CLI's `validate`, `build` and `install`, and the Codex
 * hook's blocking reason — so the person and the agent read the same next step.
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
