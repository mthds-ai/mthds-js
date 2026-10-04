import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitInputsTemplate,
  runProtocolValidate,
} from "../../../src/agent/commands/api-commands.js";
import { runnerProblemExtras } from "../../../src/agent/output.js";
import { ApiResponseError, ApiUnreachableError } from "../../../src/runners/api/exceptions.js";
import type { ProblemDetails } from "../../../src/runners/api/exceptions.js";
import type { Runner } from "../../../src/runners/types.js";

// When a runner refuses a call, the `mthds-agent` error envelope must carry what
// the runner's problem document said: who can fix it (`error_domain`), the next
// step (`hint`), whether a retry helps (`retryable`) and the request id to hand
// to support (`request_id`) — the way the local `pipelex-agent` reads a report.

function apiError(status: number, problem: ProblemDetails): ApiResponseError {
  return new ApiResponseError(
    `API POST /v1/validate failed (${status}): refused`,
    "http://localhost:8081",
    status,
    "",
    "{}",
    "SomeRunnerError",
    "refused",
    undefined,
    { problem },
  );
}

function throwingRunner(err: unknown): Runner {
  return { type: "api", validate: vi.fn().mockRejectedValue(err) } as unknown as Runner;
}

describe("runnerProblemExtras", () => {
  it("carries the runner's domain, next step, retry advice and request id", () => {
    expect(
      runnerProblemExtras(
        apiError(500, {
          errorDomain: "runtime",
          retryable: true,
          userAction: { kind: "wait_and_retry", detail: "Wait a minute, then retry." },
          requestId: "req-1",
        }),
      ),
    ).toEqual({
      error_domain: "runtime",
      hint: "Wait a minute, then retry.",
      retryable: true,
      request_id: "req-1",
    });
  });

  it("leaves out every member the runner did not send", () => {
    expect(runnerProblemExtras(apiError(500, {}))).toEqual({});
  });

  it("leaves retryable out when the runner said false, as the envelope only ever says true", () => {
    expect(runnerProblemExtras(apiError(422, { retryable: false }))).toEqual({});
  });

  it("does not carry a domain outside the runner vocabulary", () => {
    expect(runnerProblemExtras(apiError(500, { errorDomain: "elsewhere" }))).toEqual({});
  });

  it("carries the refusal's validation items whole", () => {
    const items = [
      {
        category: "pipe_validation" as const,
        message: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
        missing_pipe_code: "demo.summarise",
        suggested_fix: {
          fix_code: "rename-pipe",
          description: "Rename 'summarise' to 'summarize'",
          safety: "safe" as const,
          ops: [],
        },
      },
    ];
    const err = new ApiResponseError(
      "API POST /v1/start failed (422): invalid",
      "http://localhost:8081",
      422,
      "",
      "{}",
      "ValidateBundleError",
      "invalid",
      items,
      { problem: { errorDomain: "input" } },
    );
    expect(runnerProblemExtras(err)).toEqual({ error_domain: "input", validation_errors: items });
  });

  it("leaves an empty validation list out, as it names nothing to fix", () => {
    const err = new ApiResponseError("x", "http://x", 422, "", "{}", undefined, undefined, []);
    expect(runnerProblemExtras(err)).toEqual({});
  });

  it("yields nothing for an error that is not a runner's refusal", () => {
    expect(
      runnerProblemExtras(new ApiUnreachableError("down", "http://x", "ECONNREFUSED")),
    ).toEqual({});
    expect(runnerProblemExtras(new Error("plain"))).toEqual({});
  });
});

describe("mthds-agent envelope for a runner's refusal", () => {
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

  function firstEnvelope(): Record<string, unknown> {
    return JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  it("prints the domain, the next step and the request id on a server fault", async () => {
    const runner = throwingRunner(
      apiError(500, {
        errorDomain: "config",
        userAction: {
          kind: "contact_support",
          detail: "Ask the runner's operator to set the key.",
        },
        requestId: "req-500",
      }),
    );
    await expect(runProtocolValidate(runner, ["x"], false, undefined, "json")).rejects.toThrow(
      "__exit__",
    );
    expect(firstEnvelope()).toMatchObject({
      error: true,
      error_type: "RunnerError",
      error_domain: "config",
      hint: "Ask the runner's operator to set the key.",
      request_id: "req-500",
    });
  });

  it("prints the runner's domain and request id on a request-shape 422", async () => {
    const runner = throwingRunner(
      apiError(422, { errorDomain: "input", retryable: false, requestId: "req-422" }),
    );
    await expect(runProtocolValidate(runner, ["x"], false, undefined, "json")).rejects.toThrow(
      "__exit__",
    );
    const envelope = firstEnvelope();
    expect(envelope).toMatchObject({
      error_type: "ValidationError",
      message: "refused",
      error_domain: "input",
      request_id: "req-422",
    });
    expect(envelope).not.toHaveProperty("retryable");
  });

  it("prints the runner's classification on the pipe I/O route's refusal (inputs)", async () => {
    const runner = {
      type: "api",
      pipeIo: vi.fn().mockRejectedValue(
        apiError(422, {
          errorDomain: "input",
          userAction: { kind: "change_input", detail: "Name a pipe the bundle declares." },
          requestId: "req-build",
        }),
      ),
    } as unknown as Runner;
    await expect(
      emitInputsTemplate(runner, { files: [{ content: "x" }] }, "demo.nope", {
        format: "json",
        explicit: false,
      }),
    ).rejects.toThrow("__exit__");
    expect(firstEnvelope()).toMatchObject({
      error_type: "RunnerError",
      error_domain: "input",
      hint: "Name a pipe the bundle declares.",
      request_id: "req-build",
    });
  });

  it("keeps the command's own domain and hint when the runner classified nothing", async () => {
    const runner = throwingRunner(apiError(500, {}));
    await expect(runProtocolValidate(runner, ["x"], false, undefined, "json")).rejects.toThrow(
      "__exit__",
    );
    const envelope = firstEnvelope();
    expect(envelope).toMatchObject({
      error_type: "RunnerError",
      error_domain: "runner",
      hint: "Check that the runner is properly configured.",
    });
    expect(envelope).not.toHaveProperty("request_id");
  });
});
