import { describe, expect, it } from "vitest";
import { formatCliError, withSuggestedFix } from "../../../src/cli/commands/error-output.js";
// Imported through the client-safe `mthds/errors` entry, so a dropped re-export
// of the classes or of the problem types fails here.
import { ApiResponseError, ApiUnreachableError } from "../../../src/errors.js";
import type { ApiResponseErrorOptions, ProblemDetails, UserAction } from "../../../src/errors.js";
import type { ValidationErrorItem } from "../../../src/runners/api/models.js";

// `formatCliError` is what the `mthds` CLI prints when a command fails. A
// runner's refusal must reach the person with who can fix it, the next step,
// whether a retry helps and the request id to quote to support.

function apiError(problem: ProblemDetails, validationErrors?: unknown[]): ApiResponseError {
  const options: ApiResponseErrorOptions = { problem };
  return new ApiResponseError(
    "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
    "http://localhost:8081",
    422,
    "Unprocessable Entity",
    "{}",
    "ModelChoiceNotFoundError",
    "Model 'gpt-9' is not in the model deck.",
    validationErrors as ValidationErrorItem[] | undefined,
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

  it("reads a runtime domain without assuming a run happened (validate and build start none)", () => {
    expect(formatCliError(apiError({ errorDomain: "runtime" })).split("\n")).toContain(
      "Error domain: runtime (a failure on the runner's side, not in the request)",
    );
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

  it("prints a refusal's validation items between the message and the problem members", () => {
    const text = formatCliError(
      apiError({ errorDomain: "input", requestId: "req-7" }, [
        {
          category: "pipe_validation",
          message: "Model handle 'gpt-9' was not found in the model deck.",
          pipe_code: "summarize",
          field_name: "model",
          source: "demo.mthds",
          suggested_fix: {
            fix_code: "rename-model",
            description: "Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
            safety: "safe",
            ops: [],
          },
        },
        {
          category: "blueprint_validation",
          message: "Concept 'Invoice' refines 'Documnet', which no bundle declares.",
          concept_code: "Invoice",
          missing_concept_code: "Documnet",
        },
      ]),
    );
    expect(text.split("\n")).toEqual([
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
      "- [pipe_validation] Model handle 'gpt-9' was not found in the model deck. (pipe: summarize, field: model, source: demo.mthds)",
      "  Suggested fix: Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
      "- [blueprint_validation] Concept 'Invoice' refines 'Documnet', which no bundle declares. (concept: Invoice, missing concept: Documnet)",
      "Error domain: input (the request must change)",
      "Request id: req-7 (quote it to support)",
    ]);
  });

  it("prints a refusal whose item list is empty as one without a list", () => {
    expect(formatCliError(apiError({}, []))).toBe(
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
    );
  });

  it("skips an item that is not an object (version-skewed payload)", () => {
    const text = formatCliError(
      apiError({}, [null, "nope", { category: "pipe_validation", message: "real" }]),
    );
    expect(text.split("\n")).toEqual([
      "API POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck.",
      "- [pipe_validation] real",
    ]);
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

// Every surface that prints a validation item puts the runner's suggested fix under
// it the same way: `Suggested fix: <description>`, indented two spaces past the item.
describe("withSuggestedFix", () => {
  const fix = {
    fix_code: "rename-model",
    description: "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5'",
    safety: "safe",
    ops: [],
  };

  it("puts the fix's description under the item's line", () => {
    expect(withSuggestedFix("- [pipe_validation] unknown model", { suggested_fix: fix })).toBe(
      "- [pipe_validation] unknown model\n  Suggested fix: Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5'",
    );
  });

  it("indents the fix two spaces past an indented item", () => {
    expect(withSuggestedFix("  [pipe_validation] unknown model", { suggested_fix: fix })).toBe(
      "  [pipe_validation] unknown model\n    Suggested fix: Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5'",
    );
  });

  it("leaves the line alone when the item has no fix, or a malformed one", () => {
    for (const item of [
      {},
      { suggested_fix: null },
      { suggested_fix: "rename it" },
      { suggested_fix: { description: 42 } },
      { suggested_fix: { description: "   " } },
      null,
      "not an item",
    ]) {
      expect(withSuggestedFix("line", item)).toBe("line");
    }
  });
});
