import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatCliError,
  formatItemLines,
  verdictSummary,
} from "../../../src/cli/commands/error-output.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
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

describe("formatCliError", () => {
  it("prints the title and detail, the route and status, the next step, the code with its verdict and the request id", () => {
    const text = formatCliError(apiError({ ...PROBLEM, request_id: "req-123" }));
    expect(text.split("\n")).toEqual([
      "The model is not known: Model 'gpt-9' is not in the model deck.",
      "POST /v1/execute failed (422 Unprocessable Entity).",
      "Next step: Pick a model the runner lists.",
      "Code: model.unknown (domain input, retry no)",
      "Request id: req-123",
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
      "POST /v1/execute failed (422 Unprocessable Entity).",
      "Next step: Pick a model the runner lists.",
      "Code: model.unknown (domain input, retry no)",
      "Request id: req-7",
      "- model.unknown: Model handle 'gpt-9' was not found in the model deck. (pipe 'summarize', field 'model', file 'demo.mthds')",
      "  Suggested fix (unsafe, rename-model): Replace model 'gpt-9' of pipe 'summarize' with 'gpt-5'",
      "- method.concept_unresolved: Concept 'Invoice' refines 'Documnet', which no bundle declares. (file 'demo.mthds', line 4)",
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

// An answer that is no problem document, such as a gateway's own JSON or HTML, reads as a problem
// the client states in the registry's words, which cannot say what the server said. The CLI prints
// the route, the status and the start of the body beside it, so the person reads the server's own
// words, never a URL's query, which may hold a presigned signature, and never what
// `POST /blobs/missing` answered, whose upload URLs are the permission to write.
describe("formatCliError for an answer that is no problem document", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A client whose every request is answered with `status` and `body`. */
  function answering(status: number, body: string, statusText: string): MthdsApiClient {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status, statusText, headers: { "Content-Type": "text/plain" } }),
    );
    return new MthdsApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
  }

  async function printed(call: Promise<unknown>): Promise<string[]> {
    const err = await call.then(
      () => expect.fail("expected the call to throw"),
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ApiResponseError);
    return formatCliError(err).split("\n");
  }

  it("prints a 401 that is no problem with the route, the status and what the server said", async () => {
    const client = answering(401, '{"detail":"Invalid authentication token"}', "Unauthorized");
    const lines = await printed(client.execute({ pipe_code: "p" }));
    expect(lines).toContain("POST /v1/execute failed (401 Unauthorized).");
    expect(lines).toContain('The server answered: {"detail":"Invalid authentication token"}');
    expect(lines).toContain("Code: client.response_unreadable (domain runtime, retry no)");
    // What the server said comes before the next step, as in the error's own message.
    const said = lines.indexOf('The server answered: {"detail":"Invalid authentication token"}');
    expect(said).toBeLessThan(lines.findIndex((line) => line.startsWith("Next step: ")));
  });

  it("prints a gateway's page with the route, the status and the start of the page", async () => {
    const page = "<html>\n<body><h1>504 Gateway Time-out</h1></body>\n</html>";
    const client = answering(504, page, "Gateway Timeout");
    const lines = await printed(client.execute({ pipe_code: "p" }));
    expect(lines).toContain("POST /v1/execute failed (504 Gateway Timeout).");
    expect(lines).toContain(
      "The server answered: <html> <body><h1>504 Gateway Time-out</h1></body> </html>",
    );
    expect(lines).toContain("Code: client.outcome_unknown (domain runtime, retry outcome_unknown)");
  });

  it("cuts every URL the body names before its query, and drops its userinfo", async () => {
    // The second URL is written with its slashes escaped, as JSON may write them.
    const body = String.raw`{"detail":"Upload refused","target":"https://user:pass@bucket.example.com/blobs/abc?X-Amz-Signature=sig-123#frag","escaped":"https:\/\/store.example.com\/b?token=tok-456"}`;
    const client = answering(403, body, "Forbidden");
    const text = (await printed(client.models())).join("\n");
    expect(text).toContain("https://bucket.example.com/blobs/abc");
    expect(text).toContain(String.raw`https:\/\/store.example.com\/b`);
    for (const secret of ["sig-123", "frag", "user:pass", "tok-456", "X-Amz-Signature"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("never prints what POST /blobs/missing answered", async () => {
    const body =
      '{"missing":[{"upload":{"url":"https://bucket.example.com/b?X-Amz-Signature=s"}}]}';
    const client = answering(500, body, "Internal Server Error");
    const err = await client
      .findMissingBlobs({ digest: `sha256:${"a".repeat(64)}`, blobs: [] })
      .then(
        () => expect.fail("expected the call to throw"),
        (caught: unknown) => caught as ApiResponseError,
      );
    expect(err.answerExcerpt).toBeUndefined();
    expect(err.message).not.toContain("bucket.example.com");
    const lines = formatCliError(err).split("\n");
    expect(lines).toContain("POST /v1/blobs/missing failed (500 Internal Server Error).");
    expect(lines.join("\n")).not.toContain("bucket.example.com");
    expect(lines.join("\n")).not.toContain("The server answered");
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
