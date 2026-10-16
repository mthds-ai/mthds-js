import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import {
  ApiResponseError,
  ApiTransportError,
  PipelineRequestError,
  ProblemError,
  RunStillRunningError,
} from "../../../src/runners/api/exceptions.js";
import { buildProblem } from "../../../src/problems/build.js";
import { PIPE_SELECTION_CODES } from "../../../src/runners/types.js";
import { MTHDS_JS_VERSION } from "../../../src/version.js";

const BASE_URL = "http://localhost:8081";

/** The smallest body `POST /execute` answers with: the run's id and its output. */
const RUN_RESULT = { pipeline_run_id: "x", pipe_output: {} };

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({
    baseUrl: BASE_URL,
    apiKey: "test-token",
  });
}

/** What fetch throws when the transport fails: undici's own failure as the `cause`. */
function networkError(code: string, syscall?: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & {
    cause?: { code: string; syscall?: string };
  };
  err.cause = syscall === undefined ? { code } : { code, syscall };
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

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function textResponse(
  status: number,
  body: string,
  statusText = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, statusText, headers });
}

/** A fetch that answers only when the request is aborted, rejecting with the abort's reason. */
function fetchWaitingForAbort(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

/** The error a call rejects with, which the test expects it to. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => expect.fail("expected the call to throw"),
    (err: unknown) => err,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MthdsApiClient constructor", () => {
  it("defaults to the hosted base URL when nothing is configured", async () => {
    const originalUrl = process.env.MTHDS_BASE_URL;
    delete process.env.MTHDS_BASE_URL;
    try {
      const client = new MthdsApiClient({ apiKey: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, RUN_RESULT));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.pipelex.com/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.MTHDS_BASE_URL = originalUrl;
    }
  });

  it("strips trailing slashes from baseUrl and composes {base}/v1/{endpoint}", async () => {
    const client = new MthdsApiClient({
      baseUrl: "http://localhost:8081///",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RUN_RESULT));
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

  it("refuses the base URL as client.not_configured naming the setting", () => {
    let caught: unknown;
    try {
      new MthdsApiClient({ baseUrl: "https://api.pipelex.com/v1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProblemError);
    const problem = (caught as ProblemError).problem;
    expect(problem.code).toBe("client.not_configured");
    expect(problem.params).toEqual({ setting: "base_url" });
    expect(problem).not.toHaveProperty("status");
    expect((caught as ProblemError).message).toContain("host-only");
  });

  it.each(["localhost:8081", "api.pipelex.com", "ftp://api.pipelex.com", "file:///tmp"])(
    "refuses the base URL %s, whose scheme is missing or unsupported, as client.not_configured",
    (baseUrl) => {
      let caught: unknown;
      try {
        new MthdsApiClient({ baseUrl });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProblemError);
      expect((caught as ProblemError).problem.code).toBe("client.not_configured");
    },
  );

  it("reads MTHDS_BASE_URL from the environment", async () => {
    const originalUrl = process.env.MTHDS_BASE_URL;
    process.env.MTHDS_BASE_URL = "http://env-host:9999";
    try {
      const client = new MthdsApiClient({ apiKey: "t" });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse(200, RUN_RESULT));
      await client.execute({ pipe_code: "p" });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://env-host:9999/v1/execute",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      if (originalUrl !== undefined) process.env.MTHDS_BASE_URL = originalUrl;
      else delete process.env.MTHDS_BASE_URL;
    }
  });
});

describe("MthdsApiClient.execute argument validation", () => {
  it("throws PipelineRequestError when neither pipe_code nor mthds_contents provided", async () => {
    const client = makeClient();
    await expect(client.execute({})).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("codes the refusal client.argument_invalid, with no status, before any request leaves", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = await rejection(client.execute({}));
    expect(err).toBeInstanceOf(ProblemError);
    const problem = (err as ProblemError).problem;
    expect(problem.code).toBe("client.argument_invalid");
    expect(problem.params).toEqual({ argument: "pipe_code", reason: "missing" });
    expect(problem).not.toHaveProperty("status");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("MthdsApiClient transport failures", () => {
  it("reads a refused connection as client.unreachable, even on a route that creates a run", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNREFUSED", "connect"));
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiTransportError);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toBeInstanceOf(PipelineRequestError);
    const e = err as ApiTransportError;
    expect(e.problem).toEqual(buildProblem("client.unreachable", { base_url: BASE_URL }));
    expect(e.networkCode).toBe("ECONNREFUSED");
    expect(e.apiUrl).toBe(BASE_URL);
    expect(e.message).toContain(BASE_URL);
    expect(e.retry).toBe("yes");
    expect(e.cause).toBeInstanceOf(TypeError);
  });

  it("reads an unknown host as client.unreachable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ENOTFOUND", "getaddrinfo"));
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiTransportError);
    expect((err as ApiTransportError).code).toBe("client.unreachable");
    expect((err as ApiTransportError).networkCode).toBe("ENOTFOUND");
  });

  it("reads a connection lost once execute's request left as client.outcome_unknown", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNRESET", "read"));
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiTransportError);
    const e = err as ApiTransportError;
    expect(e.problem).toEqual(buildProblem("client.outcome_unknown", {}));
    expect(e.problem.params).toEqual({});
    expect(e.retry).toBe("outcome_unknown");
    expect(e.networkCode).toBe("ECONNRESET");
  });

  it("reads a failure that names no cause on a route that creates a run as client.outcome_unknown", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const err = await rejection(client.start({ pipe_code: "p" }));
    expect((err as ApiTransportError).code).toBe("client.outcome_unknown");
    expect((err as ApiTransportError).networkCode).toBeUndefined();
  });

  it("reads a lost connection on a route that creates nothing as client.unreachable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNRESET", "read"));
    const err = await rejection(client.models());
    expect(err).toBeInstanceOf(ApiTransportError);
    expect((err as ApiTransportError).problem).toEqual(
      buildProblem("client.unreachable", { base_url: BASE_URL }),
    );
  });

  it("reads the client's own time limit on a read as client.timeout naming the seconds", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchWaitingForAbort);
    const pending = rejection(client.models());
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await pending;
    expect(err).toBeInstanceOf(ApiTransportError);
    expect((err as ApiTransportError).problem).toEqual(
      buildProblem("client.timeout", { seconds: 30 }),
    );
  });

  it("reads the client's own time limit on execute as client.outcome_unknown", async () => {
    vi.useFakeTimers();
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchWaitingForAbort);
    const pending = rejection(client.execute({ pipe_code: "p" }));
    await vi.advanceTimersByTimeAsync(1_200_000);
    const err = await pending;
    expect((err as ApiTransportError).problem).toEqual(buildProblem("client.outcome_unknown", {}));
  });

  it("never repeats a request by itself", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(networkError("ECONNRESET", "read"));
    await rejection(client.execute({ pipe_code: "p" }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("MthdsApiClient redirects", () => {
  let server: Server | undefined;
  const requests: string[] = [];

  /** A loopback runtime that redirects `/v1/execute`, `/v1/start` and `/v1/models`. */
  async function redirectingRuntime(target: (origin: string) => string): Promise<string> {
    requests.length = 0;
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
      if (request.url === "/v1/models-moved") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      response.writeHead(307, { Location: target(origin), "Content-Type": "text/plain" });
      response.end("Temporary Redirect");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it.each([
    ["execute", (client: MthdsApiClient) => client.execute({ pipe_code: "p" })],
    ["start", (client: MthdsApiClient) => client.start({ pipe_code: "p" })],
  ])(
    "reads a redirect on %s as the answer, never sending the request again",
    async (_route, call) => {
      // The target refuses every connection: followed, the redirect would read as a runtime the
      // client never reached, although the request reached the one that redirected it.
      const origin = await redirectingRuntime(() => "http://127.0.0.1:9/v1/elsewhere");
      const client = new MthdsApiClient({ baseUrl: origin, apiKey: "test-token" });
      const err = await rejection(call(client));
      expect(err).toBeInstanceOf(ApiResponseError);
      const e = err as ApiResponseError;
      expect(e.status).toBe(307);
      expect(e.problem).toEqual(buildProblem("client.response_unreadable", { status: 307 }));
      expect(e.responseBody).toBe("Temporary Redirect");
      expect(requests).toHaveLength(1);
    },
  );

  it("follows a redirect on a route that creates nothing", async () => {
    const origin = await redirectingRuntime((self) => `${self}/v1/models-moved`);
    const client = new MthdsApiClient({ baseUrl: origin, apiKey: "test-token" });
    await expect(client.models()).resolves.toEqual({ models: [] });
    expect(requests).toEqual(["GET /v1/models", "GET /v1/models-moved"]);
  });
});

describe("MthdsApiClient answers that are no problem document", () => {
  it("reads a success body holding a number no double holds as client.response_unreadable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(200, '{"pipeline_run_id":"r","pipe_output":{"score":1e999}}'),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
  });

  it("reads an overlong Retry-After as no delay, without throwing", async () => {
    const client = makeClient();
    const problem = buildProblem("runtime.unavailable", {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(503, problem, { "Retry-After": "9".repeat(400) }),
    );
    const err = await rejection(client.models());
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem).not.toHaveProperty("retry_after");
    expect((err as ApiResponseError).retryAfter).toBeUndefined();
  });

  it("reads a JSON body of another shape as client.response_unreadable naming the status", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, { detail: "Invalid authentication token" }),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(401);
    expect(e.route).toBe("POST /v1/execute");
    expect(e.problem).toEqual(buildProblem("client.response_unreadable", { status: 401 }));
    expect(e.responseBody).toContain("Invalid authentication token");
    // A problem the client builds carries no status: the answer's is in its parameters.
    expect(e.problem).not.toHaveProperty("status");
    // The message names the route and status, the problem's sentence and next step, then the
    // start of the body, which no member of the problem holds.
    expect(e.message).toBe(
      `POST /v1/execute failed (401): ${e.problem.detail} ${e.problem.next_step.detail} ` +
        `The answer's body begins: {"detail":"Invalid authentication token"}`,
    );
    expect(JSON.stringify(e.problem)).not.toContain("Invalid authentication token");
  });

  it("reads a pre-registry error envelope as client.response_unreadable too", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, {
        detail: { error_type: "CredentialsError", message: "Missing OPENAI_API_KEY" },
      }),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect((err as ApiResponseError).status).toBe(500);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as ApiResponseError).problem.params).toEqual({ status: 500 });
  });

  it("retains the raw body and the status text when the body is not JSON", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(502, "Bad Gateway", "Bad Gateway"),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(502);
    expect(e.statusText).toBe("Bad Gateway");
    expect(e.responseBody).toBe("Bad Gateway");
    expect(e.problem.code).toBe("client.response_unreadable");
    expect(e.problem.params).toEqual({ status: 502 });
  });

  it("reads an empty 503 on a read as runtime.unavailable, with its status and Retry-After", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(503, "", "Service Unavailable", { "Retry-After": "5" }),
    );
    const err = await rejection(client.models());
    const e = err as ApiResponseError;
    expect(e.problem).toEqual(
      buildProblem("runtime.unavailable", {}, { status: 503, retryAfter: 5 }),
    );
    expect(e.problem.params).toEqual({});
    expect(e.retry).toBe("yes");
    expect(e.retryAfter).toBe(5);
  });

  it("never reads an empty 503 on execute as a code that invites a repeat", async () => {
    // The answer may come after the run started, so it reads as unreadable,
    // whose verdict is not `yes`, rather than as runtime.unavailable.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(503, "", "Service Unavailable", { "Retry-After": "5" }),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    const e = err as ApiResponseError;
    expect(e.problem).toEqual(buildProblem("client.response_unreadable", { status: 503 }));
    expect(e.retry).not.toBe("yes");
  });

  it("reads a bare 405 as request.method_not_allowed", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(405, ""));
    const err = await rejection(client.version());
    const e = err as ApiResponseError;
    expect(e.problem).toEqual(buildProblem("request.method_not_allowed", {}, { status: 405 }));
    expect(e.problem).not.toHaveProperty("params");
  });

  it("reads a 2xx whose body is not the route's result as client.response_unreadable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { pipeline_run_id: "ok", created_at: "t0" }),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem).toEqual(
      buildProblem("client.response_unreadable", { status: 200 }),
    );
  });

  it("reads a 2xx whose body is not JSON as client.response_unreadable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(200, "OK"));
    const err = await rejection(client.models());
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as ApiResponseError).problem.params).toEqual({ status: 200 });
  });
});

describe("MthdsApiClient problem documents", () => {
  // A runner's problem document for a caller's own mistake: the core members,
  // and members of the runner's own (`instance`, `request_id`, `rule_version`),
  // which a reader keeps whatever they hold.
  const PROBLEM = {
    type: "https://mthds.ai/errors/model.unknown",
    title: "The model is not known",
    status: 422,
    detail: "Model 'gpt-9' is not in the model deck.",
    code: "model.unknown",
    domain: "input",
    retry: "no",
    next_step: { kind: "change_input", detail: "Pick a model listed by `mthds-agent models`." },
    params: { model: "gpt-9" },
    instance: "/v1/execute",
    request_id: "req-body-123",
    rule_version: 3,
  };

  async function executeError(response: Response): Promise<ApiResponseError> {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    return err as ApiResponseError;
  }

  it("keeps the problem as received, every member included", async () => {
    const e = await executeError(
      jsonResponse(422, PROBLEM, {
        "Content-Type": "application/problem+json",
        "X-Request-ID": "req-body-123",
      }),
    );
    expect(e.status).toBe(422);
    expect(e.problem).toEqual(PROBLEM);
    expect(e.code).toBe("model.unknown");
    expect(e.domain).toBe("input");
    expect(e.retry).toBe("no");
    expect(e.nextStep).toEqual({
      kind: "change_input",
      detail: "Pick a model listed by `mthds-agent models`.",
    });
    expect(e.requestId).toBe("req-body-123");
    expect(e.message).toBe(
      "POST /v1/execute failed (422): Model 'gpt-9' is not in the model deck. " +
        "Pick a model listed by `mthds-agent models`.",
    );
  });

  it("fills the status from the answer when the body leaves it out", async () => {
    const { status: _status, ...withoutStatus } = PROBLEM;
    const e = await executeError(jsonResponse(422, withoutStatus));
    expect(e.problem.status).toBe(422);
    expect(e.problem).toEqual({ ...withoutStatus, status: 422 });
  });

  it("fills retry_after from Retry-After only beside a retry of yes", async () => {
    const retryable = {
      ...PROBLEM,
      status: 503,
      code: "runtime.draining",
      domain: "runtime",
      retry: "yes",
    };
    const e = await executeError(jsonResponse(503, retryable, { "Retry-After": "2" }));
    expect(e.problem.retry_after).toBe(2);
    expect(e.retryAfter).toBe(2);

    const final = await executeError(jsonResponse(422, PROBLEM, { "Retry-After": "2" }));
    expect(final.problem).not.toHaveProperty("retry_after");
  });

  it("reads a domain, a retry verdict and a step kind it does not know by the fallbacks", async () => {
    const e = await executeError(
      jsonResponse(503, {
        ...PROBLEM,
        code: "quorum.lost",
        domain: "galaxy",
        retry: "later",
        next_step: { kind: "pray", detail: "Wait for the quorum." },
      }),
    );
    // As received on the problem, read into the closed lists on the error.
    expect(e.problem.domain).toBe("galaxy");
    expect(e.problem.retry).toBe("later");
    expect(e.domain).toBe("runtime");
    expect(e.retry).toBe("no");
    expect(e.nextStep.kind).toBe("report");
    expect(e.nextStep.detail).toBe("Wait for the quorum.");
  });

  it("keeps an extension code as received", async () => {
    const e = await executeError(
      jsonResponse(402, {
        ...PROBLEM,
        status: 402,
        code: "pipelex.billing.credit_exhausted",
        domain: "account",
      }),
    );
    expect(e.code).toBe("pipelex.billing.credit_exhausted");
    expect(e.domain).toBe("account");
  });

  it("reads a problem with a mistyped core member as client.response_unreadable", async () => {
    const e = await executeError(jsonResponse(422, { ...PROBLEM, status: "422" }));
    expect(e.problem).toEqual(buildProblem("client.response_unreadable", { status: 422 }));
  });

  it("takes the request id from the X-Request-ID header when the body carries none", async () => {
    const { request_id: _id, ...withoutId } = PROBLEM;
    const e = await executeError(jsonResponse(422, withoutId, { "X-Request-ID": "req-hdr-9" }));
    expect(e.requestId).toBe("req-hdr-9");
    expect(e.problem).not.toHaveProperty("request_id");
  });

  it("takes the request id from the header on a body that is not JSON", async () => {
    const e = await executeError(
      new Response("Bad Gateway", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "x-request-id": "req-gw-1" },
      }),
    );
    expect(e.requestId).toBe("req-gw-1");
    expect(e.responseBody).toBe("Bad Gateway");
  });

  it("prefers the body's request_id over the header", async () => {
    const e = await executeError(
      jsonResponse(422, PROBLEM, { "X-Request-ID": "req-header-other" }),
    );
    expect(e.requestId).toBe("req-body-123");
  });

  it("carries the problem on every route that raises ApiResponseError (start)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(422, PROBLEM));
    const err = await rejection(client.start({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).route).toBe("POST /v1/start");
    expect((err as ApiResponseError).problem).toEqual(PROBLEM);
  });
});

describe("MthdsApiClient.execute 202 degrade (eng-review 3B)", () => {
  it("throws RunStillRunningError of client.follow_failed carrying the run, Retry-After and Location", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        202,
        { pipeline_run_id: "run-202", state: "RUNNING", created_at: "t0" },
        { "Retry-After": "5", Location: "/v1/runs/run-202/status" },
      ),
    );
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(RunStillRunningError);
    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as RunStillRunningError;
    expect(e.problem).toEqual(buildProblem("client.follow_failed", { pipeline_run_id: "run-202" }));
    expect(e.problem).not.toHaveProperty("pipeline_run_id");
    expect(e.runId).toBe("run-202");
    expect(e.retryAfterSeconds).toBe(5);
    expect(e.location).toBe("/v1/runs/run-202/status");
    expect(e.message).toContain("run-202");
    expect(e.message).toContain("Read the run 'run-202' by its id rather than start it again.");
    expect(e.retry).toBe("outcome_unknown");
  });

  it("reads a 202 that names no run as client.outcome_unknown", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(202, "accepted"));
    const err = await rejection(client.execute({ pipe_code: "p" }));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect(err).not.toBeInstanceOf(RunStillRunningError);
    expect((err as ApiResponseError).problem).toEqual(buildProblem("client.outcome_unknown", {}));
  });
});

describe("MthdsApiClient happy path", () => {
  it("returns the parsed RunResult on 200", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        pipeline_run_id: "ok",
        pipe_output: {},
        created_at: "t0",
        state: "COMPLETED",
      }),
    );
    const result = await client.execute({ pipe_code: "p" });
    expect(result.pipeline_run_id).toBe("ok");
    expect(result.state).toBe("COMPLETED"); // server extension field, preserved via the index signature
  });
});

describe("MthdsApiClient method-bundle transport (files / bundle_b64)", () => {
  it("sends the files map on execute and accepts a bundle-only request", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "ok", pipe_output: {} }));
    // No pipe_code, no mthds_contents — the bundle alone satisfies the precondition.
    await client.execute({
      files: { "m.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." },
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.files).toEqual({ "m.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." });
    expect(body.mthds_contents).toBeUndefined();
  });

  it("sends bundle_b64 on start", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(202, { pipeline_run_id: "run-b", state: "STARTED" }));
    await client.start({ bundle_b64: "UEsDBBQ=" });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.bundle_b64).toBe("UEsDBBQ=");
  });

  it("an empty files map does NOT satisfy the precondition", async () => {
    const client = makeClient();
    await expect(client.execute({ files: {} })).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("rejects files + bundle_b64 before dispatch (two encodings of one bundle)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = await rejection(
      client.execute({ files: { "m.mthds": "domain = 'x'" }, bundle_b64: "UEsDBBQ=" }),
    );
    expect(err).toBeInstanceOf(PipelineRequestError);
    expect((err as ProblemError).problem.code).toBe("client.argument_invalid");
    expect((err as ProblemError).problem.params).toEqual({
      argument: "bundle_b64",
      reason: "conflicts_with_files",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a bundle combined with mthds_contents before dispatch (bundle is self-contained)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.execute({ files: { "m.mthds": "domain = 'x'" }, mthds_contents: ["domain = 'y'"] }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("start() also rejects a bundle combined with mthds_contents before dispatch", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      client.start({ bundle_b64: "UEsDBBQ=", mthds_contents: ["domain = 'y'"] }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects bundle fields smuggled through `extra` (reserved request keys)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const err = await rejection(
      client.execute({ pipe_code: "p", extra: { files: { "m.mthds": "domain = 'x'" } } }),
    );
    expect(err).toBeInstanceOf(PipelineRequestError);
    expect((err as ProblemError).problem.params).toEqual({
      argument: "extra",
      reason: "protocol_arg",
    });
    await expect(
      client.execute({ pipe_code: "p", extra: { bundle_b64: "UEsDBBQ=" } }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not ship an empty files map on the wire", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { pipeline_run_id: "ok", pipe_output: {} }));
    // pipe_code satisfies the precondition; the empty `files` must be dropped so
    // the runner never sees a zero-file bundle.
    await client.execute({ pipe_code: "registered_pipe", files: {} });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.files).toBeUndefined();
    expect(body.pipe_code).toBe("registered_pipe");
  });
});

describe("MthdsApiClient.start", () => {
  it("POSTs /v1/start and returns the RunResult ack", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-1", state: "STARTED", created_at: "t0" }),
      );

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
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-2", state: "STARTED", created_at: "t0" }),
      );
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
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "client-id", state: "STARTED", created_at: "t0" }),
      );
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
      client.start({ mthds_contents: ["domain d"], extra: { pipe_code: "smuggled" } }),
    ).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("throws PipelineRequestError when pipe_code, mthds_contents, and extra are all missing", async () => {
    const client = makeClient();
    await expect(client.start({})).rejects.toBeInstanceOf(PipelineRequestError);
  });

  it("surfaces a non-2xx start as ApiResponseError (hosted 422 on client pipeline_run_id)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: "Client-supplied pipeline_run_id is not accepted" }),
    );
    const err = await client
      .start({ pipe_code: "p", pipeline_run_id: "nope" } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(422);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
  });
});

describe("MthdsApiClient.validate", () => {
  it("POSTs /v1/validate with mthds_contents + allow_signatures and returns the valid report", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        bundle_blueprint: { domain: "x" },
        graph_spec: null,
        pipe_io_contracts: {},
        validated_pipes: [],
        pending_signatures: [],
        is_runnable: true,
      }),
    );

    const report = await client.validate(["domain = 'x'"], true);

    expect(report.is_valid).toBe(true);
    if (report.is_valid === false) throw new Error("expected a valid report");
    expect(report.bundle_blueprint).toEqual({ domain: "x" });
    expect(report.is_runnable).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8081/v1/validate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      mthds_contents: ["domain = 'x'"],
      allow_signatures: true,
      render: ["markdown"],
    });
  });

  it("defaults allow_signatures to false", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.allow_signatures).toBe(false);
  });

  it("returns the neutral valid verdict on a 200, preserving server extension fields", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: true,
        bundle_blueprint: { domain: "x" },
        pipe_io_contracts: { "x.greet": { inputs: {}, output: {} } },
        graph_spec: null,
        validated_pipes: [{ pipe_ref: "x.greet", status: "SUCCESS" }],
        pending_signatures: [],
        is_runnable: true,
        message: "MTHDS content validated successfully",
        mthds_contents: ["domain = 'x'"],
      }),
    );
    const report = await client.validate(["domain = 'x'"]);
    expect(report.is_valid).toBe(true);
    if (report.is_valid === false) throw new Error("expected a valid report");
    // `validate()` returns the protocol's neutral `ValidationResult`; the structural
    // artifacts ride the extension index signature (typed `unknown` here, typed in
    // `@pipelex/sdk`'s `PipelexValidationReport`) but are preserved verbatim.
    expect(report).toMatchObject({
      validated_pipes: [{ pipe_ref: "x.greet", status: "SUCCESS" }],
      pending_signatures: [],
      is_runnable: true,
      graph_spec: null,
    });
  });

  it("returns the InvalidReport arm (200, is_valid: false) for an invalid bundle — not a throw", async () => {
    const client = makeClient();
    // The 200-diagnostic contract: an invalid bundle is a produced verdict, not a
    // transport failure. The body carries the discriminant and one problem item per
    // fault, each located in the file `mthds_sources` named, no structural artifacts.
    const items = [
      {
        code: "method.schema_violation",
        detail: "The main pipe declares no output.",
        location: { file: "broken.mthds" },
      },
      {
        code: "method.concept_unresolved",
        detail: "The concept 'demo.Missing' is not declared.",
        params: { concept_ref: "demo.Missing" },
        location: { pipe: "demo.greet", file: "broken.mthds", line: 12 },
        rule_version: 2,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        errors: items,
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    );
    const report = await client.validate(["broken"], false, ["broken.mthds"]);
    expect(report.is_valid).toBe(false);
    if (report.is_valid !== false) throw new Error("expected an invalid report");
    expect(report.is_runnable).toBe(false);
    expect(report.message).toBe("MTHDS validation found errors");
    // Every item is kept as received, a member of the runner's own included.
    expect(report.errors).toEqual(items);
    expect(report.errors[1]!.location?.pipe).toBe("demo.greet");
  });

  it("reads an invalid verdict whose faults are not problem items as client.response_unreadable", async () => {
    // A verdict of the shape before the error registry: `validation_errors`, no `errors`.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        validation_errors: [{ category: "blueprint_validation", message: "boom" }],
        message: "MTHDS validation found errors",
      }),
    );
    const err = await rejection(client.validate(["broken"]));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem).toEqual(
      buildProblem("client.response_unreadable", { status: 200 }),
    );
  });

  it("sends mthds_sources parallel to mthds_contents when provided", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'", "domain = 'y'"], true, ["x.mthds", "y.mthds"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({
      mthds_contents: ["domain = 'x'", "domain = 'y'"],
      allow_signatures: true,
      mthds_sources: ["x.mthds", "y.mthds"],
      render: ["markdown"],
    });
  });

  it("omits mthds_sources from the body when not provided", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));
    await client.validate(["domain = 'x'"]);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect("mthds_sources" in body).toBe(false);
  });

  it("throws ApiResponseError on a request-shape 422 (mthds_sources length mismatch)", async () => {
    const client = makeClient();
    // The no-verdict path: the runner answers a malformed request with a problem
    // document. A produced verdict never 422s — only request-shape errors do.
    const problem = {
      type: "https://mthds.ai/errors/request.invalid",
      title: "The request is invalid",
      status: 422,
      detail: "mthds_sources length must match mthds_contents",
      code: "request.invalid",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Send as many sources as contents." },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, problem, { "content-type": "application/problem+json" }),
    );
    const err = await rejection(client.validate(["x"], false, ["a", "b"]));
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(422);
    expect((err as ApiResponseError).problem).toEqual(problem);
    expect((err as ApiResponseError).problem).not.toHaveProperty("errors");
  });
});

describe("MthdsApiClient.validateFiles", () => {
  function bodyOf(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]![1] as { body?: string };
    return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  }

  it("sends content and sources for files that all have URIs", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles(
      [
        { uri: "file:///bundle/main.mthds", content: "domain = 'x'" },
        { uri: "file:///bundle/pipes.mthds", content: "pipe x.greet" },
      ],
      { allowSignatures: true },
    );

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/validate");
    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'", "pipe x.greet"],
      allow_signatures: true,
      mthds_sources: ["file:///bundle/main.mthds", "file:///bundle/pipes.mthds"],
      render: ["markdown"],
    });
  });

  it("omits mthds_sources when no file has a URI", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles([{ content: "domain = 'x'" }, { content: "pipe x.greet" }]);

    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'", "pipe x.greet"],
      allow_signatures: false,
      render: ["markdown"],
    });
  });

  it("fills deterministic inline sources for missing URIs in mixed input", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true }));

    await client.validateFiles([
      { uri: "file:///bundle/main.mthds", content: "domain = 'x'" },
      { content: "pipe x.inline" },
      { uri: "file:///bundle/other.mthds", content: "pipe x.other" },
    ]);

    expect(bodyOf(fetchSpy)).toMatchObject({
      mthds_contents: ["domain = 'x'", "pipe x.inline", "pipe x.other"],
      mthds_sources: [
        "file:///bundle/main.mthds",
        "inline://file-2.mthds",
        "file:///bundle/other.mthds",
      ],
      render: ["markdown"],
    });
  });

  it("rejects empty files before calling the API", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await rejection(client.validateFiles([]));
    expect(err).toBeInstanceOf(PipelineRequestError);
    expect((err as ProblemError).problem.params).toEqual({ argument: "files", reason: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes render options through to validate", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { is_valid: true, rendered_markdown: "# ok" }));

    await client.validateFiles([{ content: "domain = 'x'" }], { render: ["markdown"] });

    expect(bodyOf(fetchSpy)).toEqual({
      mthds_contents: ["domain = 'x'"],
      allow_signatures: false,
      render: ["markdown"],
    });
  });
});

// `/health` is origin-level, outside the `/v1` prefix, and its refusal is an
// ApiResponseError carrying its problem, as on the protocol routes.
describe("MthdsApiClient.health", () => {
  it("raises a refusal as ApiResponseError with its problem", async () => {
    const client = makeClient();
    const problem = {
      type: "https://mthds.ai/errors/runtime.misconfigured",
      title: "The runtime is misconfigured",
      status: 500,
      detail: "The model deck could not be loaded.",
      code: "runtime.misconfigured",
      domain: "operator",
      retry: "no",
      next_step: { kind: "contact_operator", detail: "Ask the runner's operator." },
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(500, problem, { "X-Request-ID": "req-health-1" }));

    const err = await rejection(client.health());

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/health");
    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.message).toBe(
      "GET /health failed (500): The model deck could not be loaded. Ask the runner's operator.",
    );
    expect(e.problem).toEqual(problem);
    expect(e).toMatchObject({
      status: 500,
      route: "GET /health",
      code: "runtime.misconfigured",
      domain: "operator",
      retry: "no",
      requestId: "req-health-1",
    });
  });

  it("reads a plain-text 503 as runtime.unavailable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(503, "Service Unavailable", "Service Unavailable"),
    );

    const err = await rejection(client.health());

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(503);
    expect((err as ApiResponseError).problem).toEqual(
      buildProblem("runtime.unavailable", {}, { status: 503 }),
    );
  });
});

describe("MthdsApiClient.pipeIo", () => {
  function bodyOf(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]![1] as { body?: string };
    return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  }

  /** The delay of every timer the client armed, which is how its request budget shows. */
  function armedTimeouts(timeoutSpy: ReturnType<typeof vi.spyOn>): unknown[] {
    return timeoutSpy.mock.calls.map((call: unknown[]) => call[1]);
  }

  const VALID = {
    is_valid: true,
    pipe_ref: "smoke.echo",
    pipe_io_contracts: {},
    input_form: { "smoke.echo": { fields: [] } },
    output_form: {},
    default_pipe_ref: "smoke.echo",
    pending_signatures: [],
    is_runnable: true,
  };

  it("posts the request verbatim to /v1/pipe-io and returns the valid arm", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID));

    const result = await client.pipeIo({
      files: [{ content: "domain = 'smoke'", source: "smoke.mthds" }],
      pipe_ref: "smoke.echo",
      all_pipes: true,
      include_files: true,
    });

    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/pipe-io");
    expect(bodyOf(fetchSpy)).toEqual({
      files: [{ content: "domain = 'smoke'", source: "smoke.mthds" }],
      pipe_ref: "smoke.echo",
      all_pipes: true,
      include_files: true,
    });
    expect(result).toEqual(VALID);
  });

  // The hosted catalog selector is a pass-through: the platform resolves it, so the
  // client neither expands it nor checks the selector XOR.
  it("passes a method_id through untouched", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, VALID));

    await client.pipeIo({ method_id: "mt_abc123" });

    expect(bodyOf(fetchSpy)).toEqual({ method_id: "mt_abc123" });
  });

  it("returns the invalid arm as a value, not an exception", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        errors: [{ code: "method.syntax", detail: "boom", params: { finding: "boom" } }],
        message: "MTHDS library could not be resolved",
      }),
    );

    const result = await client.pipeIo({ files: [{ content: "domain = 'smoke'" }] });

    expect(result.is_valid).toBe(false);
    if (result.is_valid) throw new Error("expected the invalid arm");
    expect(result.errors.map((item) => item.code)).toEqual(["method.syntax"]);
  });

  it("raises a selection refusal as ApiResponseError carrying its code", async () => {
    const client = makeClient();
    const problem = {
      type: "https://mthds.ai/errors/request.pipe_not_found",
      title: "The selected pipe is not in the method",
      status: 422,
      detail: "Pipe 'smoke.nope' not found in the submitted closure.",
      code: "request.pipe_not_found",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Select one of: smoke.echo." },
      params: { pipe_ref: "smoke.nope", candidates: ["smoke.echo"] },
      request_id: "req-io-1",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(422, problem));

    const err = await rejection(
      client.pipeIo({ files: [{ content: "domain = 'smoke'" }], pipe_ref: "smoke.nope" }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(PIPE_SELECTION_CODES.has(e.code)).toBe(true);
    expect(e.problem).toEqual(problem);
    expect(e).toMatchObject({ status: 422, route: "POST /v1/pipe-io", requestId: "req-io-1" });
    expect(e.message).toBe(
      "POST /v1/pipe-io failed (422): Pipe 'smoke.nope' not found in the submitted closure. " +
        "Select one of: smoke.echo.",
    );
  });

  it("reads a network failure as ApiTransportError of client.unreachable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(networkError("ECONNREFUSED", "connect"));

    const err = await rejection(client.pipeIo({ files: [{ content: "x" }] }));
    expect(err).toBeInstanceOf(ApiTransportError);
    expect((err as ApiTransportError).code).toBe("client.unreachable");
  });

  // A `method_ref` can make the server clone a repository first, so it gets the
  // fetch-sized budget; inline files get the static-route one.
  it("gives a method_ref the fetch-sized budget and inline files the static one", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse(200, VALID)),
    );
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await client.pipeIo({ method_ref: "github.com/acme/methods@v1.0.0" });
    expect(armedTimeouts(timeoutSpy)).toContain(180_000);

    timeoutSpy.mockClear();
    await client.pipeIo({ files: [{ content: "x" }] });
    expect(armedTimeouts(timeoutSpy)).toContain(30_000);
    expect(armedTimeouts(timeoutSpy)).not.toContain(180_000);
  });
});

describe("MthdsApiClient problem items keep their next step", () => {
  // The two items a runner sends for a refused bundle: an unknown model, whose one
  // close match becomes a `rename-model` suggested fix, and an unresolved pipe
  // dependency, which names the missing pipe. Each carries members of the runner's
  // own, which a reader keeps.
  const UNKNOWN_MODEL_ITEM = {
    code: "model.unknown",
    detail: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
    params: { model: "gpt-5.1" },
    location: { pipe: "summarize", file: "demo.mthds", path: ["pipe", "summarize", "model"] },
    suggestions: ["gpt-5"],
    suggested_fix: {
      fix_code: "rename-model",
      description:
        "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
      safety: "unsafe",
      file: "demo.mthds",
      ops: [
        {
          kind: "remap_value",
          table_path: ["pipe", "summarize"],
          key: "model",
          mapping: { "gpt-5.1": "gpt-5" },
        },
      ],
    },
    model_type: "llm",
  };
  const MISSING_PIPE_ITEM = {
    code: "method.pipe_unresolved",
    detail: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
    params: { pipe_ref: "demo.summarise" },
    location: { pipe: "main" },
  };

  it("keeps the suggested fix and the missing pipe on pipe-io's invalid verdict", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
        message: "MTHDS library could not be resolved",
      }),
    );

    const result = await client.pipeIo({ files: [{ content: "domain = 'demo'" }] });

    if (result.is_valid) throw new Error("expected the invalid arm");
    const [modelItem, pipeItem] = result.errors;
    expect(modelItem).toEqual(UNKNOWN_MODEL_ITEM);
    // Typed reads: these compile because `ProblemItem` declares the members.
    expect(modelItem!.suggested_fix?.description).toContain("with 'gpt-5'");
    expect(modelItem!.suggested_fix?.ops[0]).toEqual({
      kind: "remap_value",
      table_path: ["pipe", "summarize"],
      key: "model",
      mapping: { "gpt-5.1": "gpt-5" },
    });
    expect(modelItem!.suggestions).toEqual(["gpt-5"]);
    expect(modelItem!.model_type).toBe("llm");
    expect(pipeItem!.params).toEqual({ pipe_ref: "demo.summarise" });
  });

  it("keeps the suggested fix and the missing pipe on a refusal's problem document", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        type: "https://mthds.ai/errors/method.invalid",
        title: "The method does not validate",
        status: 422,
        detail: "MTHDS validation found errors",
        code: "method.invalid",
        domain: "method",
        retry: "no",
        next_step: { kind: "change_method", detail: "Fix each fault listed in errors." },
        errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
      }),
    );

    const err = await rejection(client.execute({ pipe_code: "summarize" }));

    expect(err).toBeInstanceOf(ApiResponseError);
    const items = (err as ApiResponseError).problem.errors;
    expect(items).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
    expect(items![0]!.suggested_fix?.fix_code).toBe("rename-model");
    expect(items![0]!.suggested_fix?.safety).toBe("unsafe");
    expect(items![1]!.code).toBe("method.pipe_unresolved");
  });

  it("reads a refusal holding an item that is not a problem item as client.response_unreadable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        type: "https://mthds.ai/errors/method.invalid",
        title: "The method does not validate",
        status: 422,
        detail: "MTHDS validation found errors",
        code: "method.invalid",
        domain: "method",
        retry: "no",
        next_step: { kind: "change_method", detail: "Fix each fault listed in errors." },
        errors: [{ category: "pipe_validation", message: "boom" }],
      }),
    );

    const err = await rejection(client.execute({ pipe_code: "summarize" }));

    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
  });
});

describe("MthdsApiClient.models", () => {
  it("GETs /v1/models and returns the deck", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        models: [{ name: "gpt-4o", type: "llm" }],
        aliases: {},
        waterfalls: {},
      }),
    );
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        protocol_version: "0.6.0",
        implementation: "pipelex-api",
        implementation_version: "1.2.3",
        runtime_version: "0.32.0",
      }),
    );
    const info = await client.version();
    expect(info.implementation).toBe("pipelex-api");
    expect(info.protocol_version).toBe("0.6.0");
    expect(info.runtime_version).toBe("0.32.0");
    // Typed extension field — clients gate capabilities on it without reaching
    // through the untyped index signature.
    const implVersion: string | undefined = info.implementation_version;
    expect(implVersion).toBe("1.2.3");
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8081/v1/version");
  });
});

describe("MthdsApiClient.validate render extra", () => {
  function bodyOf(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0]![1] as { body?: string };
    return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  }

  it("sends markdown render in the request body when asked", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, ["markdown"]);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("requests markdown render when none is requested", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("requests markdown render when given an empty list", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, []);
    expect(bodyOf(fetchSpy).render).toEqual(["markdown"]);
  });

  it("keeps caller render tokens while adding markdown", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { is_valid: true, rendered_markdown: "# Validation passed" }),
      );
    await client.validate(["domain = 'x'"], false, undefined, ["html"]);
    expect(bodyOf(fetchSpy).render).toEqual(["html", "markdown"]);
  });
});

describe("MthdsApiClient User-Agent (client-identification spec)", () => {
  const LIBRARY_UA = `mthds-js/${MTHDS_JS_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`;

  function headersOf(fetchSpy: ReturnType<typeof vi.spyOn>, call = 0): Record<string, string> {
    const init = fetchSpy.mock.calls[call]![1] as { headers: Record<string, string> };
    return init.headers;
  }

  it("sends the library User-Agent on requestRaw paths (protocol routes)", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RUN_RESULT));
    await client.execute({ pipe_code: "p" });
    expect(headersOf(fetchSpy)["User-Agent"]).toBe(LIBRARY_UA);
  });

  it("sends the library User-Agent on the requestJson path (health)", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { ok: true }));
    await client.health();
    expect(headersOf(fetchSpy)["User-Agent"]).toBe(LIBRARY_UA);
  });

  it("sends it on the pipe I/O extension and GET routes too", async () => {
    const client = makeClient();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, { is_valid: true }));
    await client.pipeIo({ method_id: "mt_abc123" });
    // The answer is no version, so the call fails: what it sent is what this checks.
    await client.version().catch(() => undefined);
    expect(headersOf(fetchSpy, 0)["User-Agent"]).toBe(LIBRARY_UA);
    expect(headersOf(fetchSpy, 1)["User-Agent"]).toBe(LIBRARY_UA);
  });

  it("puts appInfo in front of the library token", async () => {
    const client = new MthdsApiClient({
      baseUrl: BASE_URL,
      apiKey: "t",
      appInfo: {
        name: "acme-invoicer",
        version: "1.4.0",
        details: ["batch"],
        url: "https://acme.test",
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RUN_RESULT));
    await client.execute({ pipe_code: "p" });
    expect(headersOf(fetchSpy)["User-Agent"]).toBe(
      `acme-invoicer/1.4.0 (batch; +https://acme.test) ${LIBRARY_UA}`,
    );
  });

  it("keeps the other headers alongside it", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RUN_RESULT));
    await client.execute({ pipe_code: "p" });
    expect(headersOf(fetchSpy)).toEqual({
      Accept: "application/json",
      "User-Agent": LIBRARY_UA,
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    });
  });

  it("refuses an invalid appInfo at construction with a TypeError", () => {
    expect(
      () => new MthdsApiClient({ baseUrl: BASE_URL, appInfo: { name: "acme invoicer" } }),
    ).toThrow(TypeError);
    expect(
      () =>
        new MthdsApiClient({ baseUrl: BASE_URL, appInfo: { name: "acme", details: ["not ok"] } }),
    ).toThrow(TypeError);
  });

  it("sets no User-Agent in a browser", async () => {
    vi.stubGlobal("window", { document: {} });
    vi.stubGlobal("process", { ...process, versions: {} });
    let client: MthdsApiClient;
    try {
      client = new MthdsApiClient({ baseUrl: BASE_URL, apiKey: "t", appInfo: { name: "acme" } });
    } finally {
      vi.unstubAllGlobals();
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, RUN_RESULT));
    await client.execute({ pipe_code: "p" });
    await client.health().catch(() => undefined);
    expect(headersOf(fetchSpy, 0)).not.toHaveProperty("User-Agent");
    expect(headersOf(fetchSpy, 1)).not.toHaveProperty("User-Agent");
  });
});
