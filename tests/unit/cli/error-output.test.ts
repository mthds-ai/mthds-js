import { describe, expect, it } from "vitest";
import {
  formatCliError,
  formatItemLines,
  verdictSummary,
} from "../../../src/cli/commands/error-output.js";
// Imported through the client-safe `mthds/errors` entry, so a dropped re-export
// of the classes or of the problem types fails here.
import {
  ApiResponseError,
  ApiTransportError,
  ProblemError,
  buildProblem,
} from "../../../src/errors.js";
import type { Problem, ProblemItem } from "../../../src/errors.js";

// `formatCliError` is what the `mthds` CLI prints when a command fails. A
// runner's refusal must reach the person with its title and detail, the next
// step, its code with who can fix it and whether a retry helps, and the request
// id to quote to support: the problem's plain-line rendering.

const FACTS = {
  apiUrl: "http://localhost:8081",
  route: "POST /v1/execute",
  status: 422,
  statusText: "Unprocessable Entity",
  responseBody: "{}",
};

/** A runner's problem document for a model the deck does not list. */
const PROBLEM: Problem = {
  type: "https://mthds.ai/errors/model.unknown",
  title: "The model is not known",
  status: 422,
  detail: "Model 'gpt-9' is not in the model deck.",
  code: "model.unknown",
  domain: "input",
  retry: "no",
  next_step: { kind: "change_input", detail: "Pick a model the runner lists." },
};

function apiError(problem: Problem, requestIdHeader?: string): ApiResponseError {
  return new ApiResponseError(problem, { ...FACTS, requestIdHeader });
}

const MODEL_ITEM: ProblemItem = {
  code: "model.unknown",
  detail: "Model handle 'gpt-9' was not found in the model deck.",
  location: { pipe: "summarize", field: "model", file: "demo.mthds" },
  suggested_fix: {
    fix_code: "rename-model",
    description: "Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
    safety: "unsafe",
    ops: [{ kind: "remap_value", table_path: ["pipe", "summarize"], key: "model", mapping: {} }],
  },
};

const CONCEPT_ITEM: ProblemItem = {
  code: "method.concept_unresolved",
  detail: "Concept 'Invoice' refines 'Documnet', which no bundle declares.",
  location: { file: "demo.mthds", line: 4 },
};

describe("formatCliError — the answer beside the problem", () => {
  it("names the route and the status, and quotes the start of a body that is no problem", () => {
    const err = new ApiResponseError(buildProblem("runtime.unavailable", {}, { status: 502 }), {
      ...FACTS,
      status: 502,
      statusText: "Bad Gateway",
      responseBody: "<html>upstream connect error</html>",
      bodyIsProblem: false,
    });
    const lines = formatCliError(err).split("\n");
    expect(lines).toContain("Answer: POST /v1/execute (502)");
    expect(lines).toContain("The server answered: <html>upstream connect error</html>");
  });

  it("quotes nothing of a body that is the problem itself", () => {
    const text = formatCliError(apiError(PROBLEM));
    expect(text).toContain("Answer: POST /v1/execute (422)");
    expect(text).not.toContain("The server answered");
  });
});

describe("formatCliError", () => {
  it("prints the title and detail, the next step, the code with its verdict and the request id", () => {
    const text = formatCliError(apiError({ ...PROBLEM, request_id: "req-123" }));
    expect(text.split("\n")).toEqual([
      "The model is not known: Model 'gpt-9' is not in the model deck.",
      "Next step: Pick a model the runner lists.",
      "Code: model.unknown (domain input, retry no)",
      "Request id: req-123",
      "Answer: POST /v1/execute (422)",
    ]);
  });

  it("states the seconds to wait beside a retry of yes", () => {
    const text = formatCliError(
      apiError({
        ...PROBLEM,
        code: "runtime.unavailable",
        domain: "runtime",
        retry: "yes",
        retry_after: 5,
      }),
    );
    expect(text.split("\n")).toContain(
      "Code: runtime.unavailable (domain runtime, retry yes, after 5 seconds)",
    );
  });

  it("reads a domain and a retry verdict it does not know by the fallbacks", () => {
    const text = formatCliError(
      apiError({ ...PROBLEM, code: "quorum.lost", domain: "elsewhere", retry: "later" }),
    );
    expect(text.split("\n")).toContain("Code: quorum.lost (domain runtime, retry no)");
  });

  it("prints the run a problem names", () => {
    const text = formatCliError(apiError({ ...PROBLEM, pipeline_run_id: "run_7f3a" }));
    expect(text.split("\n")).toContain("Run: run_7f3a");
  });

  it("keeps the answer's request id on the error when the problem names none", () => {
    const err = apiError(PROBLEM, "req-hdr-9");
    expect(err.requestId).toBe("req-hdr-9");
    expect(err.problem).not.toHaveProperty("request_id");
  });

  it("prints the command's own sentence under the detail of a problem the client built", () => {
    const err = new ProblemError(
      buildProblem(
        "client.argument_invalid",
        { argument: "pipe_code", reason: "missing" },
        { extra: { message: "Either pipe_code or a bundle must be provided." } },
      ),
    );
    expect(formatCliError(err).split("\n")).toEqual([
      "An argument was refused before sending: The argument 'pipe_code' was refused before any request left (reason: missing).",
      "Either pipe_code or a bundle must be provided.",
      "Next step: Correct the argument 'pipe_code', then try again.",
      "Code: client.argument_invalid (domain input, retry no)",
    ]);
  });

  it("prints a refusal's items after the problem's members, each with its fix", () => {
    const text = formatCliError(
      apiError({ ...PROBLEM, request_id: "req-7", errors: [MODEL_ITEM, CONCEPT_ITEM] }),
    );
    expect(text.split("\n")).toEqual([
      "The model is not known: Model 'gpt-9' is not in the model deck.",
      "Next step: Pick a model the runner lists.",
      "Code: model.unknown (domain input, retry no)",
      "Request id: req-7",
      "- model.unknown: Model handle 'gpt-9' was not found in the model deck. (pipe 'summarize', field 'model', file 'demo.mthds')",
      "  Suggested fix (unsafe, rename-model): Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
      "- method.concept_unresolved: Concept 'Invoice' refines 'Documnet', which no bundle declares. (file 'demo.mthds', line 4)",
      "Answer: POST /v1/execute (422)",
    ]);
  });

  it("prints a transport failure's problem the same way", () => {
    const err = new ApiTransportError(
      buildProblem("client.unreachable", { base_url: "http://x" }),
      { apiUrl: "http://x", networkCode: "ECONNREFUSED" },
    );
    expect(formatCliError(err).split("\n")).toEqual([
      "The runtime could not be reached: The client could not connect to the runtime at http://x.",
      "Next step: Check that the runtime at http://x is up and reachable, then try again.",
      "Code: client.unreachable (domain runtime, retry yes)",
    ]);
  });

  it("prints only the message for any other error", () => {
    expect(formatCliError(new Error("plain"))).toBe("plain");
    expect(formatCliError("a string")).toBe("a string");
  });
});

describe("verdictSummary", () => {
  it("opens an invalid verdict with its own message", () => {
    expect(verdictSummary("MTHDS validation found errors")).toBe("MTHDS validation found errors");
  });

  it("falls back to the title of method.invalid when the verdict has none", () => {
    expect(verdictSummary(undefined)).toBe("The method does not validate");
  });
});

// Every surface of the `mthds` CLI that prints a verdict's item puts the
// suggested fix under it the same way, indented two spaces past the item.
describe("formatItemLines", () => {
  it("prints the item's code, detail and location, then its fix", () => {
    expect(formatItemLines(MODEL_ITEM)).toEqual([
      "- model.unknown: Model handle 'gpt-9' was not found in the model deck. (pipe 'summarize', field 'model', file 'demo.mthds')",
      "  Suggested fix (unsafe, rename-model): Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
    ]);
  });

  it("indents the fix two spaces past an indented item", () => {
    expect(formatItemLines(MODEL_ITEM, "  ")).toEqual([
      "  - model.unknown: Model handle 'gpt-9' was not found in the model deck. (pipe 'summarize', field 'model', file 'demo.mthds')",
      "    Suggested fix (unsafe, rename-model): Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
    ]);
  });

  it("prints an item with no fix and no location on one line", () => {
    expect(formatItemLines({ code: "method.syntax", detail: "boom" })).toEqual([
      "- method.syntax: boom",
    ]);
  });

  it("reads a fix safety it does not know as unsafe", () => {
    const [, fixLine] = formatItemLines({
      ...MODEL_ITEM,
      suggested_fix: { ...MODEL_ITEM.suggested_fix!, safety: "probably" },
    });
    expect(fixLine).toBe(
      "  Suggested fix (unsafe, rename-model): Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
    );
  });
});
