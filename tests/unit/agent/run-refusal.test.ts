import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";
import type { ProblemItem } from "../../../src/problems/types.js";

// A runner that refuses to run an invalid method answers the run route with a 422
// problem document carrying the method's faults in `errors`. `mthds-agent run start`
// relays that problem whole, each item whole, so the agent learns which pipe, which
// field and what fix — as `mthds-agent validate` already tells it.

const UNKNOWN_MODEL_ITEM: ProblemItem = {
  code: "model.unknown",
  detail: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  params: { model: "gpt-5.1", model_type: "llm", suggestions: ["gpt-5"] },
  location: { pipe: "summarize", field: "model" },
  suggestions: ["gpt-5"],
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "unsafe",
    ops: [
      {
        kind: "remap_value",
        table_path: ["pipe", "summarize"],
        key: "model",
        mapping: { "gpt-5.1": "gpt-5" },
      },
    ],
  },
};

const MISSING_PIPE_ITEM: ProblemItem = {
  code: "method.pipe_unresolved",
  detail: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  params: { pipe: "main", missing: "demo.summarise", candidates: [] },
  location: { pipe: "main" },
};

const BUNDLE = 'domain = "demo"\nmain_pipe = "main"\n';

function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

describe("mthds-agent run start envelope for a refused invalid method", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chooseErrorFormat("json");
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

  function envelope(): Record<string, unknown> {
    return JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  async function runStart(response: Response): Promise<void> {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    // As `agent-cli.ts` sets it up: the `run` group passes its options through.
    const program = new Command().enablePositionalOptions().exitOverride();
    registerApiRunnerCommands(
      program,
      () => new MthdsApiClient({ baseUrl: "http://localhost:8081", apiKey: "test" }),
    );
    await program.parseAsync(["run", "start", "--content", BUNDLE], { from: "user" });
  }

  it("relays the refusal's problem whole, with each item, its domain and next step", async () => {
    const problem = {
      type: "https://mthds.ai/errors/method.invalid",
      title: "The method does not validate",
      status: 422,
      detail: "The method is invalid.",
      code: "method.invalid",
      domain: "method",
      retry: "no",
      next_step: { kind: "change_method", detail: "Fix the bundle, then run it again." },
      errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
      request_id: "req-run-422",
    };
    await expect(runStart(problemResponse(422, problem))).rejects.toThrow("__exit__");

    // Beside it rides what the runtime answered: the route and the status, which the problem's
    // JSON form leaves out, and no excerpt, since the body is the problem itself.
    const { status: _status, ...relayed } = problem;
    expect(envelope()).toEqual({
      ...relayed,
      server_answer: { route: "POST /v1/start", status: 422 },
    });
    expect(envelope()).toMatchObject({
      code: "method.invalid",
      domain: "method",
      next_step: { kind: "change_method", detail: "Fix the bundle, then run it again." },
      request_id: "req-run-422",
    });
    expect(envelope().errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });

  it("carries no errors on a refusal that has none", async () => {
    await expect(
      runStart(
        problemResponse(500, {
          type: "https://mthds.ai/errors/runtime.unexpected",
          title: "Unexpected runtime error",
          status: 500,
          detail: "An internal error occurred.",
          code: "runtime.unexpected",
          domain: "runtime",
          retry: "no",
          next_step: { kind: "report", detail: "Report this to whoever runs the runtime." },
          request_id: "req-run-500",
        }),
      ),
    ).rejects.toThrow("__exit__");

    expect(envelope()).toMatchObject({
      code: "runtime.unexpected",
      domain: "runtime",
      request_id: "req-run-500",
    });
    expect(envelope()).not.toHaveProperty("errors");
    expect(envelope()).not.toHaveProperty("status");
  });

  it("reads a server error whose body is not a problem as an outcome left unknown", async () => {
    // A proxy's 502 may stand in front of a run that started.
    await expect(
      runStart(new Response("<html>Bad gateway</html>", { status: 502 })),
    ).rejects.toThrow("__exit__");
    expect(envelope()).toMatchObject({ code: "client.outcome_unknown", params: {} });
  });

  it("reads a refusal whose body is not a problem by its status", async () => {
    await expect(runStart(new Response("Not Found", { status: 404 }))).rejects.toThrow("__exit__");
    expect(envelope()).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 404 },
    });
  });
});
