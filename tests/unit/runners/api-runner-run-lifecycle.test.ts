import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config so the runner constructor does not read the real filesystem.
vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    apiUrl: "http://localhost:8081",
    apiKey: "test-token",
    telemetry: false,
  })),
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

describe("ApiRunner.execute (durable platform path)", () => {
  it("starts a run on the platform then polls to the result", async () => {
    const runner = new ApiRunner("http://localhost:8081", "test-token");
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

    const result = await runner.execute({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-1");
    expect(result.pipeline_state).toBe("COMPLETED");
    expect(result.main_stuff).toEqual({ answer: 42 });
    expect(result.graph_spec).toEqual({ n: 1 });
    expect(result.pipe_output).toBeNull();

    // First call hits the platform start endpoint, not the runner execute one.
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/platform/v1/runs");
  });
});

describe("ApiRunner run-lifecycle delegation", () => {
  it("startRun returns the run record", async () => {
    const runner = new ApiRunner("http://localhost:8081", "test-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "run-9", status: "RUNNING", workflow_id: "wf-9" })
    );
    const run = await runner.startRun({ pipe_code: "p", mthds_contents: ["x"] });
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
  it("rejects run-lifecycle calls with a clear unsupported message", async () => {
    const runner = new PipelexRunner();
    await expect(runner.startRun({ pipe_code: "p" })).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getRun("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.waitForResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
  });
});
