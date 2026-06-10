import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/client/client.js";
import {
  ApiResponseError,
  PipelineRequestError,
  RunFailedError,
  RunTimeoutError,
} from "../../../src/client/exceptions.js";
import { isTerminalRunStatus, isSuccessRunStatus } from "../../../src/client/runs.js";

const RUNNER_URL = "http://localhost:8081/runner/v1";
const PLATFORM_URL = "http://localhost:8081/platform/v1";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    runnerBaseUrl: RUNNER_URL,
    platformBaseUrl: PLATFORM_URL,
    apiToken: "test-token",
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run status helpers", () => {
  it("classifies terminal vs non-terminal statuses", () => {
    expect(isTerminalRunStatus("COMPLETED")).toBe(true);
    expect(isTerminalRunStatus("FAILED")).toBe(true);
    expect(isTerminalRunStatus("TIMED_OUT")).toBe(true);
    expect(isTerminalRunStatus("RUNNING")).toBe(false);
    expect(isTerminalRunStatus("PENDING")).toBe(false);
  });

  it("treats only COMPLETED as success", () => {
    expect(isSuccessRunStatus("COMPLETED")).toBe(true);
    expect(isSuccessRunStatus("FAILED")).toBe(false);
    expect(isSuccessRunStatus("CANCELLED")).toBe(false);
  });
});

describe("MthdsApiClient.startRun", () => {
  it("POSTs to the platform runs endpoint with the run body", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "run-1", status: "PENDING" }));

    const run = await client.startRun({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });

    expect(run.pipeline_run_id).toBe("run-1");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/platform/v1/runs");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });
  });

  it("starts an ad-hoc run with mthds_contents and no pipe_code", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "run-2", status: "PENDING" }));
    await client.startRun({ mthds_contents: ["domain = 'x'\nmain_pipe = 'p'"] });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.pipe_code).toBeUndefined();
    expect(body.mthds_contents).toEqual(["domain = 'x'\nmain_pipe = 'p'"]);
  });

  it("throws PipelineRequestError when neither pipe_code nor mthds_contents is given", async () => {
    const client = makeClient();
    await expect(client.startRun({})).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("surfaces a non-2xx start as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, { detail: { error_type: "Forbidden", message: "no scope" } })
    );
    await expect(client.startRun({ pipe_code: "p" })).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("MthdsApiClient.getRun", () => {
  it("GETs the by-id endpoint and returns the run", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "run-1", status: "RUNNING", degraded: false }));

    const run = await client.getRun("run-1");

    expect(run.status).toBe("RUNNING");
    expect(run.degraded).toBe(false);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/platform/v1/runs/by-id/run-1");
    expect(init).toMatchObject({ method: "GET" });
  });

  it("attaches retry_after_seconds from the Retry-After header on a degraded read", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-1", status: "RUNNING", degraded: true }, { "Retry-After": "7" })
    );
    const run = await client.getRun("run-1");
    expect(run.degraded).toBe(true);
    expect(run.retry_after_seconds).toBe(7);
  });

  it("url-encodes the run id", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "a/b", status: "RUNNING", degraded: false }));
    await client.getRun("a/b");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/platform/v1/runs/by-id/a%2Fb");
  });
});

describe("MthdsApiClient.getResult", () => {
  it("maps 202 to a running state with the retry hint", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "5" }));
    const state = await client.getResult("run-1");
    expect(state).toEqual({ state: "running", pipeline_run_id: "run-1", retry_after_seconds: 5 });
  });

  it("maps 200 to a completed state carrying the artifacts", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { answer: 42 }, graph_spec: { nodes: [] } })
    );
    const state = await client.getResult("run-1");
    expect(state.state).toBe("completed");
    if (state.state === "completed") {
      expect(state.result.main_stuff).toEqual({ answer: 42 });
      expect(state.result.graph_spec).toEqual({ nodes: [] });
    }
  });

  it("maps 409 to a failed state and extracts the status from the message", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, {
        detail: { error_type: "ConflictError", message: "Run finished with status TIMED_OUT; no result available" },
      })
    );
    const state = await client.getResult("run-1");
    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.status).toBe("TIMED_OUT");
      expect(state.message).toContain("TIMED_OUT");
    }
  });

  it("treats 503 (Temporal degraded) as a running/retry state, never an error", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(503, { "Retry-After": "5" }));
    const state = await client.getResult("run-1");
    expect(state.state).toBe("running");
  });

  it("defaults the degraded retry when no Retry-After header is present", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202));
    const state = await client.getResult("run-1");
    if (state.state === "running") {
      expect(state.retry_after_seconds).toBe(5);
    }
  });

  it("surfaces unexpected non-2xx as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { detail: "not found" }));
    await expect(client.getResult("run-1")).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("MthdsApiClient.waitForResult", () => {
  it("polls until the run completes and returns the result", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { ok: true } }));

    const result = await client.waitForResult("run-1", { intervalMs: 0 });
    expect(result.main_stuff).toEqual({ ok: true });
  });

  it("throws RunFailedError when the run reaches a terminal failure", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(
        jsonResponse(409, {
          detail: { error_type: "ConflictError", message: "Run finished with status FAILED; no result available" },
        })
      );

    const error = await client.waitForResult("run-1", { intervalMs: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunFailedError);
    expect((error as RunFailedError).runId).toBe("run-1");
    expect((error as RunFailedError).status).toBe("FAILED");
  });

  it("throws RunTimeoutError when the deadline elapses before terminal", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "0" }));
    const error = await client
      .waitForResult("run-1", { intervalMs: 0, timeoutMs: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunTimeoutError);
    expect((error as RunTimeoutError).runId).toBe("run-1");
  });

  it("stops polling when the abort signal fires", async () => {
    const client = makeClient();
    const controller = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort();
      return emptyResponse(202, { "Retry-After": "0" });
    });
    const error = await client
      .waitForResult("run-1", { intervalMs: 50, signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
  });

  it("invokes onPoll with attempt + elapsed while running", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(emptyResponse(202, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: {} }));
    const polls: number[] = [];
    await client.waitForResult("run-1", {
      intervalMs: 0,
      onPoll: (info) => polls.push(info.attempt),
    });
    expect(polls).toEqual([1]);
  });
});
