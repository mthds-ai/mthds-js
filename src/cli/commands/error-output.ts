import { ApiResponseError } from "../../runners/api/exceptions.js";

/**
 * How the `mthds` CLI reads each `error_domain` of a runner's problem document
 * to the person at the terminal: whose move the fix is.
 */
const ERROR_DOMAIN_READINGS: Record<string, string> = {
  input: "the request must change",
  config: "the runner's configuration must change, not the request",
  runtime: "the run failed while executing",
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
