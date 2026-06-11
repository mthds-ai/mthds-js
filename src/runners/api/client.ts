import { BaseRunner } from "../base-runner.js";
import { Runners } from "../types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
} from "../types.js";
import type { RunOptions, RunRequest, StartOptions, StartRequest } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  RunResultStart,
  ValidationReport,
  VersionInfo,
} from "../../protocol/models.js";
import type { DictPipeOutput, DictRunResultExecute } from "./models.js";
import type {
  RunRead,
  RunResults,
  RunResultState,
  RunStatus,
  WaitForResultOptions,
} from "./runs.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
} from "./exceptions.js";

interface MthdsApiClientOptions {
  /** API token (Bearer). Falls back to `MTHDS_API_KEY`. Optional for anonymous bare runners. */
  apiToken?: string;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`. Falls back to `MTHDS_API_URL`, then the hosted
   * default.
   */
  baseUrl?: string;
}

/** Low-level transport over a generic fetch, before status interpretation. */
interface RawResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

/** Hosted default — the SDK composes every endpoint as `{base}/v1/{endpoint}`. */
export const DEFAULT_API_BASE_URL = "https://api.pipelex.com";

// The SDK composes every endpoint from one origin (MTHDS_API_URL): `{base}/v1/{endpoint}`.
// The same paths are served by the hosted MTHDS API (api.pipelex.com) and by a bare
// pipelex-api runner (localhost:8081) — the protocol surface is identical; only the
// hosted extensions (e.g. run polling) differ, detectable via GET /v1/version.
const API_PREFIX = "v1";
const RUNS = "runs";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single status/result GETs; the hosted gateway caps responses at ~30s.
const DEFAULT_DEGRADED_RETRY_SECONDS = 5; // matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.

/**
 * `VersionInfo.implementation` of the bare open-source runner (no run store).
 * Anything else — the hosted `pipelex-hosted` first — is assumed to serve the
 * durable run-lifecycle extension; a wrong guess still fails with the clear
 * `RunLifecycleUnavailableError` on the first poll.
 */
const BARE_RUNNER_IMPLEMENTATION = "pipelex-api";

/**
 * Client for any MTHDS runner — and THE API runner (parity D8). One class,
 * two consumers: `pipelex-app` instantiates it directly as a protocol client,
 * the CLI gets it via `createRunner()` as a full `Runner`. `extends BaseRunner
 * implements Runner` so it carries the protocol surface, the Pipelex build
 * extensions, and the lifecycle composites (`waitForResult` /
 * `startAndWaitForResult`, inherited from `BaseRunner`).
 *
 * One base URL (`MTHDS_API_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare.
 * - **run lifecycle** (`getRunStatus` / `getRunResult` / `waitForResult`) — the
 *   durable polling extension that survives long runs and lets a caller resume by
 *   id. Served only by a deployment that includes the platform block (the hosted
 *   MTHDS API); a bare `pipelex-api` runner 404s those routes, which the lifecycle
 *   methods translate into a clear `RunLifecycleUnavailableError`.
 */
export class MthdsApiClient extends BaseRunner implements Runner {
  readonly type: RunnerType = Runners.API;

  private readonly apiToken: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  /** Cached `/v1/version` handshake outcome — whether the durable lifecycle is served. */
  private lifecycleAvailable: boolean | undefined;

  constructor(options: MthdsApiClientOptions = {}) {
    super();
    this.apiToken = options.apiToken ?? process.env.MTHDS_API_KEY;
    const resolvedBaseUrl =
      options.baseUrl ?? process.env.MTHDS_API_URL ?? DEFAULT_API_BASE_URL;
    this.baseUrl = resolvedBaseUrl.replace(/\/+$/, "");
    this.originUrl = new URL("/", this.baseUrl).origin;
  }

  // ── URL resolution ───────────────────────────────────────────────────

  /** Build an API URL: `<base>/v1/<endpoint>`. */
  private url(endpoint: string): string {
    return `${this.baseUrl}/${API_PREFIX}/${endpoint.replace(/^\/+/, "")}`;
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * Issue one HTTP request and return the raw status/headers/body. Wraps
   * DNS/connect/TLS/timeout failures as `ApiUnreachableError`; a caller-driven
   * abort (Ctrl-C / agent walk-away) propagates as-is so the poll loop can stop
   * cleanly. Non-2xx interpretation is left to the caller. `url` is a fully
   * resolved absolute URL.
   */
  private async requestRaw(
    method: "GET" | "POST",
    url: string,
    options: {
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    const hasBody = options.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
      timeoutMs
    );
    const userSignal = options.signal;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    if (userSignal) {
      if (userSignal.aborted) controller.abort(userSignal.reason);
      else userSignal.addEventListener("abort", onUserAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // A caller-initiated abort (not our timeout) propagates untouched so
      // `waitForResult` callers can distinguish "I stopped waiting" from a
      // network failure.
      if (userSignal?.aborted) throw err;
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // Our timeout aborts the controller with a "TimeoutError" DOMException.
      const code = extractNetworkErrorCode(err);
      throw new ApiUnreachableError(
        `Could not reach MTHDS API at ${this.baseUrl} (${code ?? "network error"})`,
        this.baseUrl,
        code,
        { cause: err }
      );
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onUserAbort);
    }

    const body = await response.text().catch(() => "");
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    };
  }

  /**
   * Issue a request and parse the JSON body, throwing a plain `Error` on a
   * non-2xx response. Used by the build extensions and `health` — surfaces
   * that don't need the protocol's structured error taxonomy.
   */
  private async requestJson<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `API ${method} ${url} failed (${res.status}): ${text || res.statusText}`
      );
    }
    return res.json() as Promise<T>;
  }

  private postApi<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson("POST", this.url(path), body);
  }

  private throwApiResponseError(
    method: "GET" | "POST",
    endpoint: string,
    res: RawResponse
  ): never {
    const { errorType, serverMessage } = parseErrorBody(res.body);
    throw new ApiResponseError(
      `API ${method} /${API_PREFIX}/${endpoint} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage
    );
  }

  /**
   * Translate a "route absent" 404 (a bare pipelex-api with no platform block)
   * into a clear `RunLifecycleUnavailableError`. The platform's own 404s (run
   * not found / cross-org) carry a structured error envelope (a `code` field)
   * and are left for normal handling.
   */
  private throwIfLifecycleUnavailable(res: RawResponse, url: string): void {
    if (res.status !== 404) return;
    if (!isMissingRoute404(res.body)) return;
    throw new RunLifecycleUnavailableError(
      `The durable run lifecycle is not available: ${url} returned 404. Run polling is a ` +
        `hosted-API extension (/${API_PREFIX}/${RUNS}/*), not part of the MTHDS Protocol; ` +
        "MTHDS_API_URL points at a bare runner that does not serve it.",
      this.baseUrl
    );
  }

  /**
   * Map the protocol's optional 202 execute degrade to a typed
   * error. Hosted does not emit 202 today, but the protocol permits it;
   * raising a typed error (with the `pipeline_run_id` + `Location` + `Retry-After`
   * hints) beats a generic parse failure on an unexpected body shape.
   */
  private throwIfExecuteDegraded(res: RawResponse): void {
    if (res.status !== 202) return;
    let runId = "";
    try {
      const parsed: unknown = JSON.parse(res.body);
      if (parsed && typeof parsed === "object") {
        const candidate = (parsed as { pipeline_run_id?: unknown }).pipeline_run_id;
        if (typeof candidate === "string") runId = candidate;
      }
    } catch {
      // Non-JSON 202 body — keep runId empty; the error message covers it.
    }
    throw new RunStillRunningError(
      `execute() was accepted asynchronously (202): run ${runId || "<unknown>"} is still ` +
        "running server-side. Poll its results (hosted) or use start().",
      runId,
      parseRetryAfter(res.headers),
      res.headers.get("location")
    );
  }

  // ── Health ────────────────────────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    // `/health` is origin-level, NOT under the `/v1` prefix.
    return this.requestJson("GET", `${this.originUrl}/health`);
  }

  // ── Protocol surface ─────────────────────────────────────────────────

  /**
   * Execute a method synchronously and wait for its completion —
   * `POST /v1/execute`.
   *
   * Behind the hosted gateway, synchronous requests terminate at ~30s; a run
   * that exceeds that surfaces as `PipelineExecuteTimeoutError` pointing at the
   * durable start+poll path. Throws `RunStillRunningError` on the protocol's
   * optional 202 degrade.
   */
  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents or a server-specific extension arg (extra) must be provided to execute()."
      );
    }

    const request: RunRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref,
      ...extensions,
    };

    const startedAt = Date.now();
    try {
      const res = await this.requestRaw("POST", this.url("execute"), {
        body: request,
      });
      this.throwIfExecuteDegraded(res);
      if (res.status < 200 || res.status >= 300) {
        this.throwApiResponseError("POST", "execute", res);
      }
      return JSON.parse(res.body) as DictRunResultExecute;
    } catch (err) {
      if (err instanceof RunStillRunningError) throw err;
      // The hosted gateway terminates synchronous requests at ~30s. A run that
      // exceeds that comes back as a gateway 503/504 (or a client abort) —
      // translate it into a clear, actionable error pointing at start+poll.
      const elapsedMs = Date.now() - startedAt;
      if (isGatewayTimeout(err, elapsedMs)) {
        throw new PipelineExecuteTimeoutError(elapsedMs, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * Server-specific extension args ride `options.extra` and merge into the
   * request body — the server you call defines and handles them (including a
   * client-supplied run id where a server supports one). The returned
   * `pipeline_run_id` is always authoritative; on a hosted deployment it is
   * durable — poll `getRunStatus` / `getRunResult`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents or a server-specific extension arg (extra) must be provided to start()."
      );
    }

    // `?? undefined` so JSON.stringify drops absent fields from the wire body.
    const request: StartRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      ...extensions,
    };

    const res = await this.requestRaw("POST", this.url("start"), {
      body: request,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res);
    }
    return JSON.parse(res.body) as RunResultStart;
  }

  /**
   * Parse, validate, and dry-run an MTHDS bundle — `POST /v1/validate`.
   *
   * Returns the structural artifacts of a valid bundle; an invalid bundle is
   * an HTTP 422 problem, surfaced as `ApiResponseError`.
   */
  async validate(
    mthdsContents: string[],
    allowSignatures = false
  ): Promise<ValidationReport> {
    const res = await this.requestRaw("POST", this.url("validate"), {
      body: { mthds_contents: mthdsContents, allow_signatures: allowSignatures },
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return JSON.parse(res.body) as ValidationReport;
  }

  /** The model deck the runner can route to — `GET /v1/models[?type=]`. */
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const endpoint = category
      ? `models?type=${encodeURIComponent(category)}`
      : "models";
    const res = await this.requestRaw("GET", this.url(endpoint), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    return JSON.parse(res.body) as ModelDeck;
  }

  /**
   * Protocol + implementation versions — `GET /v1/version` (always public).
   * The handshake for feature detection (hosted extensions or not).
   */
  async version(): Promise<VersionInfo> {
    const res = await this.requestRaw("GET", this.url("version"), {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", "version", res);
    }
    return JSON.parse(res.body) as VersionInfo;
  }

  // ── Build extensions (Pipelex API layer 2 — `/v1/build/*`) ────────

  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    return this.postApi("build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    return this.postApi("build/output", request);
  }

  async buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse> {
    return this.postApi("build/runner", request);
  }

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.postApi("build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.postApi("build/pipe-spec", request);
  }

  // ── Hosted extension: durable run lifecycle (NOT part of the protocol) ──

  /**
   * Fetch a run's status by bare id — `GET /v1/runs/{pipeline_run_id}/status`.
   *
   * Self-healing: a finished-but-unrecorded run resolves to its true terminal
   * status on read. `degraded: true` means Temporal was unreachable and
   * `status` is the last-known value; `retry_after_seconds` carries the
   * server's backoff hint when present. Throws `RunLifecycleUnavailableError`
   * when the lifecycle routes are absent (a bare runner).
   */
  async getRunStatus(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunRead> {
    const endpoint = `${RUNS}/${encodeURIComponent(runId)}/status`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const run = JSON.parse(res.body) as RunRead;
    const retryAfter = parseRetryAfter(res.headers);
    return retryAfter !== null ? { ...run, retry_after_seconds: retryAfter } : run;
  }

  /**
   * Single-shot result lookup — `GET /v1/runs/{pipeline_run_id}/results`.
   * Maps the server's poll semantics to a discriminated union:
   * - HTTP 202 → `running` (with the `Retry-After` hint)
   * - HTTP 200 → `completed` (with the result artifacts)
   * - HTTP 409 → `failed` (terminal non-`COMPLETED`)
   * - HTTP 503 → `running` (Temporal degraded — retry, never fail a poller)
   *
   * Throws `RunLifecycleUnavailableError` when the lifecycle routes are absent
   * (a bare runner).
   */
  async getRunResult(runId: string, options: { signal?: AbortSignal } = {}): Promise<RunResultState> {
    const endpoint = `${RUNS}/${encodeURIComponent(runId)}/results`;
    const url = this.url(endpoint);
    const res = await this.requestRaw("GET", url, {
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
      signal: options.signal,
    });

    if (res.status === 202 || res.status === 503) {
      return {
        state: "running",
        pipeline_run_id: runId,
        retry_after_seconds: parseRetryAfter(res.headers) ?? DEFAULT_DEGRADED_RETRY_SECONDS,
      };
    }
    if (res.status === 409) {
      const { serverMessage } = parseErrorBody(res.body);
      const message = serverMessage ?? "Run finished without a result.";
      return {
        state: "failed",
        pipeline_run_id: runId,
        status: extractRunStatusFromMessage(message),
        message,
      };
    }
    this.throwIfLifecycleUnavailable(res, url);
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("GET", endpoint, res);
    }
    const result = JSON.parse(res.body) as RunResults;
    return { state: "completed", pipeline_run_id: runId, result };
  }

  /**
   * Whether the configured server serves the durable run lifecycle, decided
   * via the `GET /v1/version` handshake (master D2) and cached for the
   * client's lifetime. A bare `pipelex-api` runner has no run store; anything
   * else is assumed hosted. When the handshake itself fails, assume hosted
   * (the SDK default) and let the start call surface the real error.
   */
  private async supportsRunLifecycle(): Promise<boolean> {
    if (this.lifecycleAvailable === undefined) {
      try {
        const info = await this.version();
        const impl = info.implementation;
        this.lifecycleAvailable = !(typeof impl === "string" && impl === BARE_RUNNER_IMPLEMENTATION);
      } catch {
        this.lifecycleAvailable = true;
      }
    }
    return this.lifecycleAvailable;
  }

  /**
   * Start a run and wait for its result.
   *
   * - **Hosted** (per the `/v1/version` handshake): durable start + poll (the
   *   `BaseRunner` composite), the path that survives the gateway's ~30s
   *   synchronous ceiling.
   * - **Bare runner** (no run store): the blocking `POST /v1/execute`, which
   *   has no gateway cap off-platform and returns the native `pipe_output`.
   */
  override async startAndWaitForResult(
    options: StartOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResults> {
    if (await this.supportsRunLifecycle()) {
      return super.startAndWaitForResult(options, pollOptions);
    }

    const response = await this.execute({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
    });
    return mapRunResultToRunResults(response);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

/**
 * Map the protocol's blocking `POST /v1/execute` response onto the lifecycle's
 * `RunResults`. The bare-runner path returns `pipe_output` (native runner
 * shape); `main_stuff` is a hosted-durable artifact and stays null here.
 * Consumers read `main_stuff ?? pipe_output` (the documented hosted/bare
 * output-shape difference).
 */
function mapRunResultToRunResults(response: DictRunResultExecute): RunResults {
  const pipeOutput = response.pipe_output as DictPipeOutput | null | undefined;
  return {
    pipeline_run_id: response.pipeline_run_id,
    main_stuff: null,
    // The bare-runner blocking `pipe_output` carries no graph artifact; the
    // hosted graph_spec rides the durable `/v1/runs/{id}/results` payload.
    graph_spec: null,
    pipe_output: (pipeOutput as Record<string, unknown> | null | undefined) ?? null,
  };
}

// The protocol's own request fields — `extra` is for extension args only.
const PROTOCOL_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "pipe_code",
  "mthds_contents",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
]);

/**
 * Validate and copy the generic `extra` passthrough. Extension args ride the
 * request body as top-level properties; protocol args must be passed as named
 * options, never smuggled through `extra`.
 */
function buildExtensions(extra: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!extra) return {};
  const overlap = Object.keys(extra).filter((key) => PROTOCOL_REQUEST_KEYS.has(key));
  if (overlap.length > 0) {
    throw new PipelineRequestError(
      `extra carries protocol args [${overlap.sort().join(", ")}] — pass them as named options instead.`
    );
  }
  return { ...extra };
}

// The hosted gateway caps synchronous requests at 30s. A failure at/after this
// threshold on the blocking execute is the timeout, not a transient outage —
// the threshold guards against mislabelling a fast 503 (runner genuinely down)
// as a timeout.
const GATEWAY_TIMEOUT_THRESHOLD_MS = 28_000;

function isGatewayTimeout(err: unknown, elapsedMs: number): boolean {
  if (elapsedMs < GATEWAY_TIMEOUT_THRESHOLD_MS) return false;
  if (err instanceof ApiResponseError) return err.status === 503 || err.status === 504;
  if (err instanceof ApiUnreachableError) return err.code === "ABORT_TIMEOUT";
  return false;
}

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ABORT_TIMEOUT";
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

/**
 * Whether a 404 is an unmatched-route 404 (no platform deployed) rather than
 * the platform's structured run-not-found 404. The platform wraps its 404s in
 * a structured envelope with a stable `code`; a bare runner returns
 * Starlette's default `{"detail": "Not Found"}` (no `code`).
 */
function isMissingRoute404(body: string): boolean {
  if (!body) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  return !("code" in parsed);
}

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

const KNOWN_RUN_STATUSES: readonly RunStatus[] = [
  "PENDING",
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
];

/**
 * The 409 detail reads "Run finished with status FAILED; no result available".
 * Pull the status word out; default to FAILED if the shape ever changes.
 */
function extractRunStatusFromMessage(message: string): RunStatus {
  const match = message.match(/status\s+([A-Z_]+)/);
  const candidate = match?.[1];
  if (candidate && (KNOWN_RUN_STATUSES as readonly string[]).includes(candidate)) {
    return candidate as RunStatus;
  }
  return "FAILED";
}

/**
 * The API serializes errors as `{"detail": {"error_type": ..., "message": ...}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s and RFC
 * 7807 problems). Both shapes are extracted here. Falls through silently on
 * non-JSON bodies.
 */
function parseErrorBody(body: string): { errorType: string | undefined; serverMessage: string | undefined } {
  if (!body) return { errorType: undefined, serverMessage: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errorType: undefined, serverMessage: undefined };
  }
  if (!parsed || typeof parsed !== "object") {
    return { errorType: undefined, serverMessage: undefined };
  }
  const root = parsed as Record<string, unknown>;
  const detail = root.detail;
  let errorType: string | undefined;
  let serverMessage: string | undefined;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === "string") errorType = d.error_type;
    if (typeof d.message === "string") serverMessage = d.message;
  } else if (typeof detail === "string") {
    serverMessage = detail;
  }
  if (errorType === undefined && typeof root.error_type === "string") errorType = root.error_type;
  if (serverMessage === undefined && typeof root.message === "string") serverMessage = root.message;
  return { errorType, serverMessage };
}
