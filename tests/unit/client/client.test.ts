import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunStillRunningError,
} from "../../../src/runners/api/exceptions.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    baseUrl: BASE_URL,
    apiToken: "test-token",
  });
}

function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & { cause?: { code: string } };
  err.cause = { code };
  return err;
}

// The constructor consults the legacy-key detector, which reads the REAL
// ~/.mthds/config — stub it out so these tests are hermetic on dev machines
// with leftover PIPELEX_* keys. The legacy fail-fast behavior itself is
// covered (with controlled mocks) in api-runner-migration.test.ts.
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...original,
    findLegacyUrlKey: () => undefined,
    findLegacyApiKeyKey: () => undefined,
  };
});

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
  it("defaults to the hosted base URL when nothing is configured", async () => {
    const originalUrl = process.env.MTHDS_API_URL;
    delete process.env.MTHDS_API_URL;
    try {
      const client = new MthdsApiClient({ apiToken: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.pipelex.com/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.MTHDS_API_URL = originalUrl;
    }
  });

  it("strips trailing slashes from baseUrl and composes {base}/v1/{endpoint}", async () => {
    const client = new MthdsApiClient({
      baseUrl: "http://localhost:8081///",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
    await client.execute({ pipe_code: "p" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8081/v1/execute",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a path-prefixed base URL instead of composing /v1/v1/...", () => {
    // A leftover path (e.g. `.../v1`) would otherwise yield malformed
    // `/v1/v1/...` endpoints with a misleading per-request error.
    expect(() => new MthdsApiClient({ baseUrl: "https://api.pipelex.com/v1" })).toThrow(
      /host-only/,
    );
    // A trailing slash on a path prefix is still a path prefix.
    expect(() => new MthdsApiClient({ baseUrl: "https://api.pipelex.com/v1/" })).toThrow(
      /host-only/,
    );
  });

  it("reads MTHDS_API_URL from the environment", async () => {
    const originalUrl = process.env.MTHDS_API_URL;
    process.env.MTHDS_API_URL = "http://env-host:9999";
    try {
      const client = new MthdsApiClient({ apiToken: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "x" }));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://env-host:9999/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.MTHDS_API_URL = originalUrl;
      else delete process.env.MTHDS_API_URL;
    }
  });
});

describe("MthdsApiClient.execute argument validation", () => {
  it("throws PipelineRequestError when neither pipe_code nor mthds_contents provided", async () => {
    const client = makeClient();
    await expect(client.execute({})).rejects.toBeInstanceOf(PipelineRequestError);
  });
});

describe("MthdsApiClient network errors", () => {
  it("wraps ECONNREFUSED in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNREFUSED"));
    try {
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiUnreachableError);
      expect(err).toBeInstanceOf(PipelineRequestError);
      const e = err as ApiUnreachableError;
      expect(e.code).toBe("ECONNREFUSED");
      expect(e.apiUrl).toBe(BASE_URL);
      expect(e.message).toContain(BASE_URL);
      expect(e.message).toContain("ECONNREFUSED");
      expect(e.cause).toBeInstanceOf(TypeError);
    }
  });

  it("wraps ENOTFOUND in ApiUnreachableError with code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ENOTFOUND"));
    try {
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
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
      await client.execute({ pipe_code: "p" });
      expect.fail("expected throw");
    } catch (err) {
      const e = err as ApiResponseError;
      expect(e.message).toContain("Service Unavailable");
    }
  });
});

describe("MthdsApiClient.execute gateway 30s timeout", () => {
  it("translates a ~30s gateway 503 into a clear PipelineExecuteTimeoutError pointing at start", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    // start = 0ms, failure observed at 31s → over the 30s gateway ceiling.
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(31_000);
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
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
    await expect(client.execute({ pipe_code: "p" })).rejects.toBeInstanceOf(
      PipelineExecuteTimeoutError
    );
  });

  it("leaves a fast 503 as an ordinary ApiResponseError (runner down, not a timeout)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(503, "", "Service Unavailable"));
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(2_000);
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(PipelineExecuteTimeoutError);
  });
});

describe("MthdsApiClient.execute 202 degrade (eng-review 3B)", () => {
  it("throws RunStillRunningError carrying pipeline_run_id, Retry-After, and Location", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        202,
        { pipeline_run_id: "run-202", state: "RUNNING", created_at: "t0" },
        { "Retry-After": "5", Location: "/v1/runs/run-202/status" }
      )
    );
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStillRunningError);
    const e = err as RunStillRunningError;
    expect(e.runId).toBe("run-202");
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.location).toBe("/v1/runs/run-202/status");
    expect(e.message).toContain("run-202");
  });

  it("survives a 202 with a malformed body (unknown run id)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(202, "accepted"));
    const err = await client.execute({ pipe_code: "p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStillRunningError);
    expect((err as RunStillRunningError).runId).toBe("");
    expect((err as RunStillRunningError).message).toContain("<unknown>");
  });
});

describe("MthdsApiClient happy path", () => {
  it("returns the parsed RunResult on 200", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "ok", created_at: "t0", state: "COMPLETED" }),
    );
    const result = await client.execute({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("ok");
    expect(result.state).toBe("COMPLETED"); // server extension field, preserved via the index signature
  });
});

describe("MthdsApiClient.start", () => {
  it("POSTs /v1/start and returns the RunResult ack", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }));

    const ack = await client.start({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });

    expect(ack.pipeline_run_id).toBe("run-1");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/start");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      pipe_code: "my_pipe",
      mthds_contents: ["domain = 'x'"],
      inputs: { a: 1 },
    });
  });

  it("merges extension args from extra into the body (extension-only start is accepted)", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(202, { pipeline_run_id: "run-2", state: "STARTED", created_at: "t0" }));
    await client.start({ inputs: { q: "hi" }, extra: { some_vendor_selector: "sel_123" } });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ some_vendor_selector: "sel_123", inputs: { q: "hi" } });
    expect(body.pipe_code).toBeUndefined();
    expect(body.mthds_contents).toBeUndefined();
    expect(body.extra).toBeUndefined();
  });

  it("passes a client-supplied pipeline_run_id through extra (server-defined extension)", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(202, { pipeline_run_id: "client-id", state: "STARTED", created_at: "t0" }));
    await client.start({
      pipe_code: "p",
      extra: { pipeline_run_id: "client-id" },
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.pipeline_run_id).toBe("client-id");
  });

  it("rejects protocol args smuggled through extra", async () => {
    const client = makeClient();
    await expect(
      client.start({ mthds_contents: ["domain d"], extra: { pipe_code: "smuggled" } })
    ).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("throws PipelineRequestError when pipe_code, mthds_contents, and extra are all missing", async () => {
    const client = makeClient();
    await expect(client.start({})).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("surfaces a non-2xx start as ApiResponseError (hosted 422 on client pipeline_run_id)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: "Client-supplied pipeline_run_id is not accepted" })
    );
    const err = await client.start({ pipe_code: "p", pipeline_run_id: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(422);
  });
});

describe("MthdsApiClient.validate", () => {
  it("POSTs /v1/validate with mthds_contents + allow_signatures and returns the report", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { blueprint: { domain: "x" }, graph_spec: {}, pipe_structures: {} }));

    const report = await client.validate(["domain = 'x'"], true);

    expect(report.blueprint).toEqual({ domain: "x" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/validate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      mthds_contents: ["domain = 'x'"],
      allow_signatures: true,
    });
  });

  it("defaults allow_signatures to false", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, {}));
    await client.validate(["domain = 'x'"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.allow_signatures).toBe(false);
  });

  it("surfaces an invalid bundle (422 problem) as ApiResponseError", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: "Bundle failed validation" })
    );
    await expect(client.validate(["broken"])).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("MthdsApiClient.models", () => {
  it("GETs /v1/models and returns the deck", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { models: [{ name: "gpt-4o", type: "llm" }], aliases: {}, waterfalls: {} }));
    const deck = await client.models();
    expect(deck.models[0]!.name).toBe("gpt-4o");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/models");
  });

  it("passes the category filter as ?type=", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { models: [], aliases: {}, waterfalls: {} }));
    await client.models("img_gen");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/models?type=img_gen");
  });
});

describe("MthdsApiClient.version", () => {
  it("GETs /v1/version and returns the VersionInfo handshake", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, {
          protocol_version: "0.6.0",
          implementation: "pipelex-api",
          implementation_version: "1.2.3",
          runtime_version: "0.32.0",
        })
      );
    const info = await client.version();
    expect(info.implementation).toBe("pipelex-api");
    expect(info.protocol_version).toBe("0.6.0");
    expect(info.runtime_version).toBe("0.32.0");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
  });
});
