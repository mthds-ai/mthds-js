import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/client/client.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
} from "../../../src/client/exceptions.js";

const RUNNER_URL = "http://localhost:8081/runner/v1";
const PLATFORM_URL = "http://localhost:8081/platform/v1";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    runnerBaseUrl: RUNNER_URL,
    platformBaseUrl: PLATFORM_URL,
    apiToken: "test-token",
  });
}

function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  err.cause = { code };
  return err;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string, statusText = ""): Response {
  return new Response(body, { status, statusText });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MthdsApiClient constructor", () => {
  it("throws ClientAuthenticationError when no runner base URL resolves", () => {
    const original = process.env.PIPELEX_RUNNER_URL;
    delete process.env.PIPELEX_RUNNER_URL;
    try {
      expect(() => new MthdsApiClient({})).toThrow(ClientAuthenticationError);
    } finally {
      if (original !== undefined) process.env.PIPELEX_RUNNER_URL = original;
    }
  });

  it("strips trailing slashes from runnerBaseUrl and appends the endpoint", async () => {
    const client = new MthdsApiClient({
      runnerBaseUrl: "http://localhost:8081/runner/v1///",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.executePipeline({ pipe_code: "p" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8081/runner/v1/pipeline/execute",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("appends the endpoint to a self-hosted runner base (no runner/v1 re-prefix)", async () => {
    const client = new MthdsApiClient({
      runnerBaseUrl: "http://localhost:8081/api/v1",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.executePipeline({ pipe_code: "p" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8081/api/v1/pipeline/execute",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("self-hosted: the run lifecycle targets the runner base when platformBaseUrl is unset", async () => {
    const client = new MthdsApiClient({
      runnerBaseUrl: "http://localhost:8081/api/v1",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ pipeline_run_id: "r1", status: "PENDING", created_at: "2026-06-07T00:00:00Z" }),
        { status: 200 },
      ),
    );
    const run = await client.startRun({ pipe_code: "p" });
    expect(run.pipeline_run_id).toBe("r1");
    expect(client.hasPlatform()).toBe(false);
    // No platform configured -> the lifecycle resolves to the runner base, not an error.
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://localhost:8081/api/v1/runs");
  });
});

describe("MthdsApiClient.executePipeline argument validation", () => {
  it("throws PipelineRequestError when neither pipe_code nor mthds_contents provided", async () => {
    const client = makeClient();
    await expect(client.executePipeline({})).rejects.toBeInstanceOf(PipelineRequestError);
  });
});

describe("MthdsApiClient network errors", () => {
  it("wraps ECONNREFUSED in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNREFUSED"));
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect(err).toBeInstanceOf(PipelineRequestError);
      const e = err as ApiUnreachableError;
      expect(e.code).toBe("ECONNREFUSED");
      expect(e.apiUrl).toBe(RUNNER_URL);
      expect(e.message).toContain(RUNNER_URL);
      expect(e.message).toContain("ECONNREFUSED");
      expect(e.cause).toBeInstanceOf(TypeError);
    }
  });

  it("wraps ENOTFOUND in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ENOTFOUND"));
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBe("ENOTFOUND");
    }
  });

  it("maps AbortSignal.timeout DOMException to ABORT_TIMEOUT", async () => {
    const client = makeClient();
    const timeoutErr = new DOMException("timed out", "TimeoutError");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutErr);
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBe("ABORT_TIMEOUT");
    }
  });

  it("falls back to undefined code when cause has no code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiUnreachableError).code).toBeUndefined();
      expect((err as ApiUnreachableError).message).toContain("network error");
    }
  });
});

describe("MthdsApiClient HTTP error responses", () => {
  it("parses 401 with detail string (auth error shape)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, { detail: "Invalid authentication token" }),
    );
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(401);
      expect(e.errorType).toBeUndefined();
      expect(e.serverMessage).toBe("Invalid authentication token");
      expect(e.responseBody).toContain("Invalid authentication token");
      expect(e.message).toContain("Invalid authentication token");
    }
  });

  it("parses 500 with nested detail dict (pipeline error shape)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, {
        detail: { error_type: "CredentialsError", message: "Missing OPENAI_API_KEY" },
      }),
    );
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(500);
      expect(e.errorType).toBe("CredentialsError");
      expect(e.serverMessage).toBe("Missing OPENAI_API_KEY");
    }
  });

  it("parses top-level error_type/message shape", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, { error_type: "FooError", message: "bar" }),
    );
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as ApiResponseError;
      expect(e.errorType).toBe("FooError");
      expect(e.serverMessage).toBe("bar");
    }
  });

  it("retains raw body when response is non-JSON", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(502, "Bad Gateway", "Bad Gateway"),
    );
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(502);
      expect(e.errorType).toBeUndefined();
      expect(e.serverMessage).toBeUndefined();
      expect(e.responseBody).toBe("Bad Gateway");
    }
  });

  it("falls back to statusText when body is empty", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    try {
      await client.executePipeline({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as ApiResponseError;
      expect(e.message).toContain("Service Unavailable");
    }
  });
});

describe("MthdsApiClient.executePipeline gateway 30s timeout", () => {
  it("translates a ~30s gateway 503 into a clear PipelineExecuteTimeoutError pointing at start", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    // start = 0ms, failure observed at 31s → over the 30s gateway ceiling.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    const err = await client.executePipeline({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PipelineExecuteTimeoutError);
    const e = err as PipelineExecuteTimeoutError;
    expect(e.message).toContain("30s");
    expect(e.message).toContain("run start");
    expect(e.elapsedMs).toBe(31_000);
  });

  it("also fires on a client-side abort timeout past the ceiling", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(30_500);
    await expect(client.executePipeline({ pipe_code: "p" })).rejects.toBeInstanceOf(
      PipelineExecuteTimeoutError
    );
  });

  it("leaves a fast 503 as an ordinary ApiResponseError (runner down, not a timeout)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(2_000);
    const err = await client.executePipeline({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(PipelineExecuteTimeoutError);
  });
});

describe("MthdsApiClient happy path", () => {
  it("returns parsed JSON on 200", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "ok" }),
    );
    const result = await client.executePipeline({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("ok");
  });
});
