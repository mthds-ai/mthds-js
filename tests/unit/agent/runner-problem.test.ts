import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitInputsTemplate,
  runProtocolValidate,
} from "../../../src/agent/commands/api-commands.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";
import { buildProblem } from "../../../src/problems/build.js";
import type { Problem, ProblemItem } from "../../../src/problems/types.js";
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
      runProtocolValidate(throwingRunner(apiError(problem, 500)), ["x"], false, undefined, "json"),
    ).rejects.toThrow("__exit__");
    const { status: _status, ...relayed } = problem;
    expect(firstEnvelope()).toEqual(relayed);
    expect(firstEnvelope()).toMatchObject({
      code: "runtime.misconfigured",
      domain: "operator",
      request_id: "req-500",
    });
  });

  it("relays a request-shape 422's code, domain, request id and items, with no is_valid", async () => {
    const problem = buildProblem(
      "request.invalid",
      { field: "mthds_contents" },
      { status: 422, errors: [MISSING_PIPE_ITEM], extra: { request_id: "req-422" } },
    );
    await expect(
      runProtocolValidate(throwingRunner(apiError(problem, 422)), ["x"], false, undefined, "json"),
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
      emitInputsTemplate(runner, { files: [{ content: "x" }] }, "demo.nope", {
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
      runProtocolValidate(throwingRunner(err), ["x"], false, undefined, "json"),
    ).rejects.toThrow("__exit__");
    expect(firstEnvelope()).toEqual(problem);
  });

  it("reads an error that carries no problem as runtime.unexpected, with its message", async () => {
    await expect(
      runProtocolValidate(
        throwingRunner(new Error("socket hung up")),
        ["x"],
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
      { field: "mthds_contents" },
      { status: 422, errors: [MISSING_PIPE_ITEM], extra: { request_id: "req-md" } },
    );
    await expect(
      runProtocolValidate(
        throwingRunner(apiError(problem, 422)),
        ["x"],
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
});
