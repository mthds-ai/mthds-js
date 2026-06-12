import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config so the runner constructor does not read the real filesystem.
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...original,
    loadConfig: vi.fn(() => ({
      runner: "api",
      baseUrl: "http://localhost:8081",
      apiKey: "test-token",
      telemetry: false,
    })),
    getConfigValue: vi.fn(() => ({ value: "http://localhost:8081", source: "file" })),
    findLegacyUrlKey: vi.fn(() => undefined),
    findLegacyApiKeyKey: vi.fn(() => undefined),
  };
});

import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";
import { RunLifecycleUnavailableError } from "../../../src/runners/api/exceptions.js";

/** The API client IS the API runner (parity D8) — construct it as a runner. */
function makeApiRunner(): MthdsApiClient {
  return new MthdsApiClient({ baseUrl: "http://localhost:8081", apiToken: "test-token" });
}

const HOSTED_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-hosted",
  implementation_version: "0.9.0",
};

const BARE_VERSION = {
  protocol_version: "0.6.0",
  implementation: "pipelex-api",
  implementation_version: "1.2.3",
  runtime_version: "0.32.0",
};

// A spec-compliant runner may report only the protocol's base fields — the
// `implementation` extension is optional. Such a base-only response cannot be
// classified by name; the runner must discover the missing lifecycle at runtime.
const BASE_ONLY_VERSION = {
  protocol_version: "0.6.0",
  runner_version: "9.9.9",
};

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

describe("ApiRunner.startAndWaitForResult (hosted — durable start+poll path)", () => {
  it("handshakes /v1/version, starts on /v1/start, then polls to the result", async () => {
    const runner = makeApiRunner();
    // version (hosted) → start (202 ack) → results (200). The 202→200
    // polling transition is covered at the client level; here we just prove
    // the runner takes the durable path and maps the result.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-1", main_stuff: { answer: 42 }, graph_spec: { n: 1 } })
      );

    const result = await runner.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-1");
    expect(result.main_stuff).toEqual({ answer: 42 });
    expect(result.graph_spec).toEqual({ n: 1 });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/start");
    expect(fetchSpy.mock.calls[2]![0]).toBe("http://localhost:8081/v1/runs/run-1/results");
  });

  it("caches the version handshake across calls", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, HOSTED_VERSION))
      .mockResolvedValueOnce(jsonResponse(202, { pipeline_run_id: "r1", state: "STARTED", created_at: "t0" }))
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "r1", main_stuff: {} }))
      .mockResolvedValueOnce(jsonResponse(202, { pipeline_run_id: "r2", state: "STARTED", created_at: "t1" }))
      .mockResolvedValueOnce(jsonResponse(200, { pipeline_run_id: "r2", main_stuff: {} }));

    await runner.startAndWaitForResult({ pipe_code: "p" });
    await runner.startAndWaitForResult({ pipe_code: "p" });

    const versionCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith("/v1/version")
    );
    expect(versionCalls).toHaveLength(1);
  });
});

describe("ApiRunner against a bare runner (no run store)", () => {
  it("startAndWaitForResult falls back to the blocking POST /v1/execute", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-x", created_at: "t0", state: "COMPLETED" })
      );

    const result = await runner.startAndWaitForResult({ pipe_code: "p", mthds_contents: ["x"] });

    expect(result.pipeline_run_id).toBe("run-x");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
  });

  it("forwards `extra` extension args through the blocking execute fallback", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BARE_VERSION))
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-x", created_at: "t0", state: "COMPLETED" })
      );

    await runner.startAndWaitForResult({
      inputs: { a: 1 },
      extra: { some_vendor_selector: "sel_123" },
    });

    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/execute");
    const body = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    // The extension arg rides the request as a top-level field — not dropped.
    expect(body.some_vendor_selector).toBe("sel_123");
  });

  it("self-heals when a base-only version response hides a missing run store", async () => {
    const runner = makeApiRunner();
    // version omits `implementation` → looks hosted → tries /v1/start, which a
    // bare runner 404s (no run created) → falls back to the blocking /v1/execute.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BASE_ONLY_VERSION))
      .mockResolvedValueOnce(jsonResponse(404, { detail: "Not Found" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-z", created_at: "t0", state: "COMPLETED" })
      )
      // A second call must skip the durable attempt entirely (negative cached).
      .mockResolvedValueOnce(
        jsonResponse(200, { pipeline_run_id: "run-z2", created_at: "t1", state: "COMPLETED" })
      );

    const result = await runner.startAndWaitForResult({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("run-z");
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      "http://localhost:8081/v1/version",
      "http://localhost:8081/v1/start",
      "http://localhost:8081/v1/execute",
    ]);

    await runner.startAndWaitForResult({ pipe_code: "p" });
    // Second call: no version re-handshake, no start retry — straight to execute.
    expect(fetchSpy.mock.calls[3]![0]).toBe("http://localhost:8081/v1/execute");
    expect(fetchSpy.mock.calls).toHaveLength(4);
  });

  it("the run-lifecycle primitives surface RunLifecycleUnavailableError on the bare 404", async () => {
    const runner = makeApiRunner();
    // Bare runner: Starlette's default 404 body — no structured `code` field.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { detail: "Not Found" })
    );

    await expect(runner.getRunStatus("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
    await expect(runner.getRunResult("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
    await expect(runner.waitForResult("r")).rejects.toBeInstanceOf(RunLifecycleUnavailableError);
  });

  it("health resolves to the origin root, not under the /v1 prefix", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { status: "ok" }));

    await runner.health();
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/health");
    expect(fetchSpy.mock.calls[0]![0]).not.toBe("http://localhost:8081/v1/health");
  });
});

describe("ApiRunner run-lifecycle delegation", () => {
  it("start returns the RunResult ack", async () => {
    const runner = makeApiRunner();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" })
    );
    const ack = await runner.start({ pipe_code: "p", mthds_contents: ["x"] });
    expect(ack.pipeline_run_id).toBe("run-9");
    expect(ack.state).toBe("STARTED"); // server extension field, preserved via the index signature
  });

  it("getRunResult reports a still-running run as running", async () => {
    const runner = makeApiRunner();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(202, { "Retry-After": "3" }));
    const state = await runner.getRunResult("run-9");
    expect(state.state).toBe("running");
  });

  it("version delegates to GET /v1/version", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, BARE_VERSION));
    const info = await runner.version();
    expect(info.implementation).toBe("pipelex-api");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
  });

  it("validate delegates to POST /v1/validate", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { blueprint: {} }));
    await runner.validate(["domain = 'x'"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/validate");
  });

  it("build helpers hit /v1/build/*", async () => {
    const runner = makeApiRunner();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, {}));
    await runner.buildInputs({ mthds_contents: ["x"], pipe_code: "p" });
    await runner.concept({ spec: {} });
    await runner.pipeSpec({ pipe_type: "PipeLLM", spec: {} });
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/build/inputs");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8081/v1/build/concept");
    expect(fetchSpy.mock.calls[2]![0]).toBe("http://localhost:8081/v1/build/pipe-spec");
  });

  it("has no checkModel — check-model never existed on the API", () => {
    const runner = makeApiRunner();
    expect((runner as unknown as Record<string, unknown>).checkModel).toBeUndefined();
  });
});

describe("PipelexRunner run-lifecycle", () => {
  it("rejects the durable run-lifecycle primitives with a clear unsupported message", async () => {
    const runner = new PipelexRunner();
    await expect(runner.start({ pipe_code: "p" })).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getRunStatus("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    await expect(runner.getRunResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
    // waitForResult is the inherited BaseRunner composite; it surfaces the same
    // unsupported error because it polls getRunResult.
    await expect(runner.waitForResult("x")).rejects.toThrow(/not supported by the pipelex CLI runner/);
  });
});
