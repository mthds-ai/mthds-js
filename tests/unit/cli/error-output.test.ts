import { describe, expect, it } from "vitest";
import { formatCliError } from "../../../src/cli/commands/error-output.js";
// Imported through the client-safe `mthds/errors` entry, so a dropped re-export
// of the classes or of the problem types fails here.
import { ApiResponseError, ApiUnreachableError } from "../../../src/errors.js";
import type { ApiResponseErrorOptions, ProblemDetails, UserAction } from "../../../src/errors.js";

// `formatCliError` is what the `mthds` CLI prints when a command fails. A
// runner's refusal must reach the person with who can fix it, the next step,
// whether a retry helps and the request id to quote to support.

function apiError(problem: ProblemDetails): ApiResponseError {
  const options: ApiResponseErrorOptions = { problem };
  return new ApiResponseError(
    "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
    "http://localhost:8081",
    422,
    "Unprocessable Entity",
    "{}",
    "ModelChoiceNotFoundError",
    "Model 'gpt-9' is not in the model deck.",
    undefined,
    options,
  );
}

describe("formatCliError", () => {
  it("prints the domain, the next step, retryability and the request id after the message", () => {
    const userAction: UserAction = {
      kind: "change_model",
      detail: "Pick a model the runner lists.",
    };
    const text = formatCliError(
      apiError({ errorDomain: "input", retryable: false, userAction, requestId: "req-123" }),
    );
    expect(text.split("\n")).toEqual([
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
      "Error domain: input (the request must change)",
      "Next step: Pick a model the runner lists.",
      "Retryable: no",
      "Request id: req-123 (quote it to support)",
    ]);
  });

  it("reads a config domain as the runner's to fix", () => {
    const text = formatCliError(apiError({ errorDomain: "config", retryable: true }));
    expect(text).toContain(
      "Error domain: config (the runner's configuration must change, not the request)",
    );
    expect(text).toContain("Retryable: yes");
  });

  it("prints a domain it has no reading for as it came", () => {
    expect(formatCliError(apiError({ errorDomain: "elsewhere" })).split("\n")).toContain(
      "Error domain: elsewhere",
    );
  });

  it("prints the request id alone when the runner sent nothing else", () => {
    expect(formatCliError(apiError({ requestId: "req-hdr-9" })).split("\n")).toEqual([
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
      "Request id: req-hdr-9 (quote it to support)",
    ]);
  });

  it("prints only the message for a response that carried no problem members", () => {
    expect(formatCliError(apiError({}))).toBe(
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
    );
  });

  it("prints only the message for any other error", () => {
    const unreachable = new ApiUnreachableError(
      "Could not reach Pipelex API at http://x (ECONNREFUSED)",
      "http://x",
      "ECONNREFUSED",
    );
    expect(formatCliError(unreachable)).toBe(
      "Could not reach Pipelex API at http://x (ECONNREFUSED)",
    );
    expect(formatCliError(new Error("plain"))).toBe("plain");
    expect(formatCliError("a string")).toBe("a string");
  });
});
