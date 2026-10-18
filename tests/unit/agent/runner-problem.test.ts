import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitInputsTemplate,
  runProtocolValidate,
} from "../../../src/agent/commands/api-commands.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";
import { buildProblem } from "../../../src/problems/build.js";
import type { Problem, ProblemItem } from "../../../src/problems/types.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { ApiResponseError, ApiTransportError } from "../../../src/runners/api/exceptions.js";
import type { Runner } from "../../../src/runners/types.js";

// When a runner refuses a call, the mthds-agent error stream relays the runner's problem whole:
// its code, its domain, its next step, its request id and its items, so the agent reads the
// runner's own account of the failure. Only `status`, presentation, is left out.

const MISSING_PIPE_ITEM: ProblemItem = {
  code: "method.pipe_unresolved",
  detail: "The pipe 'main' calls 'demo.summarise', which no bundle declares.",
  params: { pipe: "main", missing: "demo.summarise", candidates: ["demo.summarize"] },
  location: { pipe: "main", file: "demo.mthds" },
};

function apiError(problem: Problem, status: number): ApiResponseError {
  return new ApiResponseError(problem, {
    apiUrl: "http://localhost:8081",
    route: "POST /v1/validate",
    status,
    statusText: "",
    responseBody: JSON.stringify(problem),
  });
}

function throwingRunner(err: unknown): Runner {
  return { type: "api", validate: vi.fn().mockRejectedValue(err) } as unknown as Runner;
}

describe("mthds-agent error stream for a runner's refusal", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    chooseErrorFormat(undefined);
    vi.restoreAllMocks();
  });

  function firstEnvelope(): Record<string, unknown> {
    return JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  it("relays a server fault's problem whole, without its status", async () => {
    const problem = buildProblem(
      "runtime.misconfigured",
      { component: "inference" },
      { status: 500, extra: { request_id: "req-500" } },
    );
    await expect(
      runProtocolValidate(
        throwingRunner(apiError(problem, 500)),
        { files: { "x.mthds": "x" } },
        false,
        undefined,
        "json",
      ),
    ).rejects.toThrow("__exit__");
    const { status: _status, ...relayed } = problem;
    expect(firstEnvelope()).toEqual({
      ...relayed,
      server_answer: { route: "POST /v1/validate", status: 500 },
    });
    expect(firstEnvelope()).toMatchObject({
      code: "runtime.misconfigured",
      domain: "operator",
      request_id: "req-500",
    });
  });

  it("relays a request-shape 422's code, domain, request id and items, with no is_valid", async () => {
    const problem = buildProblem(
      "request.invalid",
      { field: "files" },
      { status: 422, errors: [MISSING_PIPE_ITEM], extra: { request_id: "req-422" } },
    );
    await expect(
      runProtocolValidate(
        throwingRunner(apiError(problem, 422)),
        { files: { "x.mthds": "x" } },
        false,
        undefined,
        "json",
      ),
    ).rejects.toThrow("__exit__");
    const envelope = firstEnvelope();
    expect(envelope).toMatchObject({
      code: "request.invalid",
      domain: "input",
      request_id: "req-422",
      errors: [MISSING_PIPE_ITEM],
    });
    expect(envelope).not.toHaveProperty("status");
    expect(envelope).not.toHaveProperty("is_valid");
  });

  it("relays the pipe I/O route's refusal of a selection (inputs)", async () => {
    const problem = buildProblem(
      "request.pipe_not_found",
      { pipe: "demo.nope", suggestions: ["demo.main"] },
      { status: 422, extra: { request_id: "req-build" } },
    );
    const runner = {
      type: "api",
      pipeIo: vi.fn().mockRejectedValue(apiError(problem, 422)),
    } as unknown as Runner;
    chooseErrorFormat("json");
    await expect(
      emitInputsTemplate(runner, { files: { "x.mthds": "x" } }, "demo.nope", {
        format: "json",
        explicit: false,
      }),
    ).rejects.toThrow("__exit__");
    expect(firstEnvelope()).toMatchObject({
      code: "request.pipe_not_found",
      domain: "input",
      params: { pipe: "demo.nope", suggestions: ["demo.main"] },
      request_id: "req-build",
    });
  });

  it("relays the problem of a call that got no answer", async () => {
    const problem = buildProblem("client.unreachable", { base_url: "http://localhost:8081" });
    const err = new ApiTransportError(problem, {
      apiUrl: "http://localhost:8081",
      networkCode: "ECONNREFUSED",
    });
    await expect(
      runProtocolValidate(
        throwingRunner(err),
        { files: { "x.mthds": "x" } },
        false,
        undefined,
        "json",
      ),
    ).rejects.toThrow("__exit__");
    expect(firstEnvelope()).toEqual(problem);
  });

  it("reads an error that carries no problem as runtime.unexpected, with its message", async () => {
    await expect(
      runProtocolValidate(
        throwingRunner(new Error("socket hung up")),
        { files: { "x.mthds": "x" } },
        false,
        undefined,
        "json",
      ),
    ).rejects.toThrow("__exit__");
    const envelope = firstEnvelope();
    expect(envelope).toMatchObject({
      code: "runtime.unexpected",
      domain: "runtime",
      message: "socket hung up",
    });
    expect(envelope).not.toHaveProperty("request_id");
  });

  it("renders a refusal as Markdown when the error stream is Markdown", async () => {
    const problem = buildProblem(
      "request.invalid",
      { field: "files" },
      { status: 422, errors: [MISSING_PIPE_ITEM], extra: { request_id: "req-md" } },
    );
    await expect(
      runProtocolValidate(
        throwingRunner(apiError(problem, 422)),
        { files: { "x.mthds": "x" } },
        false,
        undefined,
        "markdown",
      ),
    ).rejects.toThrow("__exit__");
    const markdown = String(stderrSpy.mock.calls[0]![0]);
    expect(markdown).toContain(`## ${problem.title}`);
    expect(markdown).toContain("`request.invalid`");
    expect(markdown).toContain("`req-md`");
    expect(markdown).toContain("`method.pipe_unresolved`");
  });

  // An answer that is no problem document reads as a problem the client states in the registry's
  // words, which cannot say what the server said; `server_answer` carries it beside the problem,
  // in the JSON form and as a section of the Markdown one, as the `mthds` CLI prints it.
  describe("an answer that is no problem document", () => {
    /** The API client as the runner, every request answered with `status` and `body`. */
    function answeringRunner(status: number, body: string): Runner {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(body, { status, headers: { "Content-Type": "text/html" } }),
      );
      return new MthdsApiClient({ baseUrl: "http://localhost:8081", apiKey: "test-token" });
    }

    async function validateWith(runner: Runner, format: "json" | "markdown"): Promise<void> {
      await expect(
        runProtocolValidate(runner, { files: { "x.mthds": "x" } }, false, undefined, format),
      ).rejects.toThrow("__exit__");
    }

    it("carries a 401's route, status and body beside client.response_unreadable", async () => {
      await validateWith(answeringRunner(401, '{"detail":"Invalid authentication token"}'), "json");
      expect(firstEnvelope()).toMatchObject({
        code: "client.response_unreadable",
        params: { status: 401 },
        server_answer: {
          route: "POST /v1/validate",
          status: 401,
          excerpt: '{"detail":"Invalid authentication token"}',
        },
      });
    });

    it("renders what a gateway answered as a section of the Markdown form", async () => {
      await validateWith(answeringRunner(502, "<html><h1>502 Bad Gateway</h1></html>"), "markdown");
      const markdown = String(stderrSpy.mock.calls[0]![0]);
      expect(markdown).toContain("`client.response_unreadable`");
      expect(markdown).toContain("### Server answer");
      expect(markdown).toContain("`POST /v1/validate` failed (502).");
      expect(markdown).toContain("```text\n<html><h1>502 Bad Gateway</h1></html>\n```");
    });

    it("never overwrites a member the runtime's problem holds under the same name", async () => {
      const problem = buildProblem(
        "runtime.misconfigured",
        { component: "inference" },
        { status: 500, extra: { server_answer: "the runtime's own" } },
      );
      await validateWith(answeringRunner(500, JSON.stringify(problem)), "json");
      expect(firstEnvelope()).toMatchObject({
        code: "runtime.misconfigured",
        server_answer: "the runtime's own",
      });
    });

    it("renders no Server answer section when the runtime's problem holds that member", async () => {
      const problem = buildProblem(
        "runtime.misconfigured",
        { component: "inference" },
        { status: 500, extra: { server_answer: "the runtime's own" } },
      );
      await validateWith(answeringRunner(500, JSON.stringify(problem)), "markdown");
      const markdown = String(stderrSpy.mock.calls[0]![0]);
      expect(markdown).toContain("`runtime.misconfigured`");
      expect(markdown).not.toContain("### Server answer");
    });
  });
});
