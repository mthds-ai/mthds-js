import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import type { ValidationErrorItem } from "../../../src/runners/api/models.js";

// A runner that refuses to run an invalid method answers the run route with a 422
// problem document carrying the bundle's validation items. `mthds-agent run start`
// must print them in its error envelope, each item whole, so the agent learns which
// pipe, which field and what fix — as `mthds-agent validate` already tells it.

const UNKNOWN_MODEL_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  pipe_code: "summarize",
  domain_code: "demo",
  field_path: "pipe.summarize.model",
  field_name: "model",
  model_reference: "gpt-5.1",
  model_type: "llm",
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

const MISSING_PIPE_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  error_type: "unresolved_pipe_dependency",
  message: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  pipe_code: "main",
  domain_code: "demo",
  missing_pipe_code: "demo.summarise",
  field_path: "pipe.main",
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
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
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

  it("carries the refusal's validation items whole, with the runner's domain and next step", async () => {
    await expect(
      runStart(
        problemResponse(422, {
          type: "https://pipelex.com/errors/validate-bundle",
          title: "Invalid bundle",
          detail: "The method is invalid.",
          error_type: "ValidateBundleError",
          error_domain: "input",
          retryable: false,
          user_action: { kind: "change_input", detail: "Fix the bundle, then run it again." },
          request_id: "req-run-422",
          validation_errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
        }),
      ),
    ).rejects.toThrow("__exit__");

    expect(envelope()).toMatchObject({
      error: true,
      error_type: "RunnerError",
      message: "API POST /v1/start failed (422): The method is invalid.",
      error_domain: "input",
      hint: "Fix the bundle, then run it again.",
      request_id: "req-run-422",
    });
    expect(envelope().validation_errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });

  it("carries no validation_errors on a refusal that has none", async () => {
    await expect(
      runStart(
        problemResponse(500, {
          detail: "An internal error occurred.",
          error_domain: "runtime",
          request_id: "req-run-500",
        }),
      ),
    ).rejects.toThrow("__exit__");

    expect(envelope()).toMatchObject({ error_domain: "runtime", request_id: "req-run-500" });
    expect(envelope()).not.toHaveProperty("validation_errors");
  });
});
