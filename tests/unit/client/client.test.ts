import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/client/client.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineRequestError,
} from "../../../src/client/exceptions.js";

const API_URL = "http://localhost:8081";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({ apiBaseUrl: API_URL, apiToken: "test-token" });
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
  it("throws ClientAuthenticationError when no apiBaseUrl resolves", () => {
    const original = process.env.PIPELEX_API_URL;
    delete process.env.PIPELEX_API_URL;
    try {
      expect(() => new MthdsApiClient({})).toThrow(ClientAuthenticationError);
    } finally {
      if (original !== undefined) process.env.PIPELEX_API_URL = original;
    }
  });

  it("strips trailing slashes from apiBaseUrl", async () => {
    const client = new MthdsApiClient({ apiBaseUrl: "http://localhost:8081///" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.executePipeline({ pipe_code: "p" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8081/api/v1/pipeline/execute",
      expect.objectContaining({ method: "POST" }),
    );
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
      expect(e.apiUrl).toBe(API_URL);
      expect(e.message).toContain(API_URL);
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
