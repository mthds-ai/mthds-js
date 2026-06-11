import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import {
  ApiResponseError,
  RunFailedError,
  RunLifecycleUnavailableError,
  RunTimeoutError,
} from "../../../src/runners/api/exceptions.js";
import { isTerminalRunStatus, isSuccessRunStatus } from "../../../src/runners/api/runs.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    baseUrl: BASE_URL,
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

describe("MthdsApiClient.getRunStatus", () => {
  it("GETs /v1/runs/{id}/status and returns the run", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "run-1", status: "RUNNING", degraded: false }));

    const run = await client.getRunStatus("run-1");

    expect(run.status).toBe("RUNNING");
    expect(run.degraded).toBe(false);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/runs/run-1/status");
    expect(init).toMatchObject({ method: "GET" });
  });

  it("attaches retry_after_seconds from the Retry-After header on a degraded read", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-1", status: "RUNNING", degraded: true }, { "Retry-After": "7" })
    );
    const run = await client.getRunStatus("run-1");
    expect(run.degraded).toBe(true);
    expect(run.retry_after_seconds).toBe(7);
  });

  it("url-encodes the run id", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "a/b", status: "RUNNING", degraded: false }));
    await client.getRunStatus("a/b");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/runs/a%2Fb/status");
  });

  it("maps a route-absent 404 (no `code` field) to RunLifecycleUnavailableError", async () => {
    // A bare runner serves Starlette's default `{"detail": "Not Found"}` — no
    // structured `code` — meaning the lifecycle routes are simply not there.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { detail: "Not Found" })
    );
    const err = await client.getRunStatus("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunLifecycleUnavailableError);
    expect((err as RunLifecycleUnavailableError).apiUrl).toBe(BASE_URL);
    expect((err as RunLifecycleUnavailableError).message).toContain("bare runner");
  });

  it("leaves a structured run-not-found 404 (with `code`) as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { detail: "Run not found", code: "run_not_found" })
    );
    const err = await client.getRunStatus("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(RunLifecycleUnavailableError);
  });
});

describe("MthdsApiClient.getRunResult", () => {
  it("maps 202 to a running state with the retry hint", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "5" }));
    const state = await client.getRunResult("run-1");
    expect(state).toEqual({ state: "running", pipeline_run_id: "run-1", retry_after_seconds: 5 });
  });

  it("hits /v1/runs/{id}/results and maps 200 to a completed state carrying the artifacts", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { answer: 42 }, graph_spec: { nodes: [] } })
    );
    const state = await client.getRunResult("run-1");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/runs/run-1/results");
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
    const state = await client.getRunResult("run-1");
    expect(state.state).toBe("failed");
    if (state.state === "failed") {
      expect(state.status).toBe("TIMED_OUT");
      expect(state.message).toContain("TIMED_OUT");
    }
  });

  it("treats 503 (Temporal degraded) as a running/retry state, never an error", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(503, { "Retry-After": "5" }));
    const state = await client.getRunResult("run-1");
    expect(state.state).toBe("running");
  });

  it("defaults the degraded retry when no Retry-After header is present", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202));
    const state = await client.getRunResult("run-1");
    if (state.state === "running") {
      expect(state.retry_after_seconds).toBe(5);
    }
  });

  it("maps a route-absent 404 (bare runner) to RunLifecycleUnavailableError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { detail: "Not Found" })
    );
    const err = await client.getRunResult("run-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunLifecycleUnavailableError);
    expect((err as RunLifecycleUnavailableError).message).toContain("/v1/runs");
  });

  it("surfaces a structured 404 (run not found) as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { detail: "Run not found", code: "run_not_found" })
    );
    await expect(client.getRunResult("run-1")).rejects.toBeInstanceOf(ApiResponseError);
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

  it("does not issue a poll once the deadline has passed (timeout checked before fetch)", async () => {
    // With the deadline already elapsed, the loop must throw before calling the
    // result endpoint — no late, wasted poll.
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(emptyResponse(202, { "Retry-After": "0" }));
    await client.waitForResult("run-1", { intervalMs: 0, timeoutMs: 0 }).catch(() => {});
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("propagates RunLifecycleUnavailableError out of the poll loop (bare runner)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(404, { detail: "Not Found" }));
    await expect(client.waitForResult("run-1", { intervalMs: 0 })).rejects.toBeInstanceOf(
      RunLifecycleUnavailableError
    );
  });
});
