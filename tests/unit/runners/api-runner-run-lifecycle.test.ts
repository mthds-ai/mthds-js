import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config so the runner constructor does not read the real filesystem.
// Hosted shape: platformUrl set, so the durable start+poll path is active.
vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    runnerUrl: "http://localhost:8081/runner/v1",
    platformUrl: "http://localhost:8081/platform/v1",
    apiKey: "test-token",
    telemetry: false,
  })),
  getConfigValue: vi.fn(() => ({ value: "http://localhost:8081/runner/v1", source: "file" })),
  hasLegacyApiUrl: vi.fn(() => false),
  LEGACY_API_URL_MIGRATION_MESSAGE: "legacy apiUrl migration",
}));

import { ApiRunner } from "../../../src/runners/api-runner.js";
import { PipelexRunner } from "../../../src/runners/pipelex-runner.js";

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

describe("ApiRunner.startAndWaitForResult (durable platform path)", () => {
  it("starts a run on the platform then polls to the result", async () => {
    // platformUrl set (hosted) → durable start+poll (the BaseRunner composite).
    const runner = new ApiRunner(
      "http://localhost:8081/runner/v1",
      "test-token",
      "http://localhost:8081/platform/v1"
    );
    // start → result(200). The 202→200 polling transition is covered at the
    // client level (waitForResult with intervalMs:0); here we just prove the
    // runner starts on the platform surface and maps the result.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-1", status: "PENDING", created_at: "t0" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { answer: 42 }, graph_spec: { n: 1 } })
      );

    const result = await runner.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-1");
    expect(result.main_stuff).toEqual({ answer: 42 });
    expect(result.graph_spec).toEqual({ n: 1 });

    // First call hits the platform start endpoint, not the runner execute one.
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/platform/v1/runs");
  });
});

describe("ApiRunner self-hosted (no platformUrl)", () => {
  it("startAndWaitForResult hits the runner's blocking /pipeline/execute, not the platform", async () => {
    // platformUrl empty → self-hosted: blocking execute against the runner base.
    const runner = new ApiRunner("http://localhost:8081/api/v1", "test-token", "");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { pipeline_run_id: "run-x", created_at: "t0", pipeline_state: "COMPLETED" })
      );

    const result = await runner.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-x");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/api/v1/pipeline/execute");
  });

  it("self-hosted: the durable run lifecycle requires the platform (no runner fallback)", async () => {
    // The durable lifecycle is platform-only — the runner has no run store. With
    // no platform configured, the primitives fail fast instead of hitting a
    // runner `/runs` endpoint that does not exist.
    const runner = new ApiRunner("http://localhost:8081/api/v1", "test-token", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(runner.start({ pipe_code: "p" })).rejects.toThrow(/platform base URL/i);
    await expect(runner.getRun("r")).rejects.toThrow(/platform base URL/i);
    await expect(runner.getResult("r")).rejects.toThrow(/platform base URL/i);
    await expect(runner.waitForResult("r")).rejects.toThrow(/platform base URL/i);

    // None of them should have hit the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("health resolves to the runner origin root, not under the version prefix", async () => {
    const runner = new ApiRunner("http://localhost:8081/api/v1", "test-token", "");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "ok" }));

    await runner.health();
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/health");
    expect(fetchSpy.mock.calls[0]![0]).not.toBe("http://localhost:8081/api/v1/health");
  });
});

describe("ApiRunner run-lifecycle delegation", () => {
  it("start returns the run record", async () => {
    const runner = new ApiRunner("http://localhost:8081", "test-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-9", status: "RUNNING", workflow_id: "wf-9" })
    );
    const run = await runner.start({ pipe_code: "p", mthds_contents: ["x"] });
    expect(run.pipeline_run_id).toBe("run-9");
    expect(run.workflow_id).toBe("wf-9");
  });

  it("getResult reports a still-running run as running", async () => {
    const runner = new ApiRunner("http://localhost:8081", "test-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "3" }));
    const state = await runner.getResult("run-9");
    expect(state.state).toBe("running");
  });
});

describe("PipelexRunner run-lifecycle", () => {
  it("rejects the durable run-lifecycle primitives with a clear unsupported message", async () => {
    const runner = new PipelexRunner();
    await expect(runner.start({ pipe_code: "p" })).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getRun("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    // waitForResult is the inherited BaseRunner composite; it surfaces the same
    // unsupported error because it polls getResult.
    await expect(runner.waitForResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
  });
});
