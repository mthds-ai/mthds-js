import { Runners } from "../types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildInputsResponse,
  BuildOutputRequest,
  BuildOutputResponse,
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
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import type { DictRunResultExecute, ValidationErrorItem } from "./models.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunStillRunningError,
} from "./exceptions.js";
import { isValidBaseUrl } from "../../config/config.js";

export interface MthdsFile {
  /** File contents to validate. */
  content: string;
  /** Optional provenance URI threaded into validation diagnostics. */
  uri?: string;
}

export interface ValidateFilesOptions {
  /** Whether unresolved pipe signatures are accepted as pending instead of invalid. */
  allowSignatures?: boolean;
  /** Optional validate presentation hints, e.g. ["markdown"]. */
  render?: string[];
}

/**
 * Request for `uploadFile` — the NON-CONTRACT `POST /v1/upload` convenience.
 * Not part of the MTHDS Protocol nor the Pipelex build extensions, which is why
 * it lives on the concrete client, not the shared `Runner` interface.
 */
export interface UploadFileRequest {
  /** Original filename with extension (e.g. `synthetic.png`). */
  filename: string;
  /** File content as a base64-encoded string. */
  data: string;
  /** Optional MIME type; the server falls back to a provider default when absent. */
  contentType?: string;
}

/** Result of `uploadFile` — the `pipelex-storage://` URI pipelex resolves at runtime. */
export interface UploadFileResult {
  /** `pipelex-storage://` URI for the uploaded file. */
  uri: string;
  /** Original filename echoed back by the server. */
  filename: string;
}

interface MthdsApiClientOptions {
  /** API key (Bearer). Falls back to `MTHDS_API_KEY`. Optional for anonymous bare runners. */
  apiKey?: string;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`. Falls back to `MTHDS_BASE_URL`, then the hosted
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

// The SDK composes every endpoint from one origin (MTHDS_BASE_URL): `{base}/v1/{endpoint}`.
// The same paths are served by the Pipelex Hosted API (api.pipelex.com) and by a bare
// OSS pipelex-api runner (localhost:8081) — the protocol surface is identical.
const API_PREFIX = "v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single GETs (models/version/start); the hosted gateway caps responses at ~30s.
const VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown";

/**
 * Client for any MTHDS runner — and THE API runner (parity D8). One class,
 * two consumers: `pipelex-app` instantiates it directly as a protocol client,
 * the CLI gets it via `createRunner()` as a full `Runner`. It carries the
 * protocol surface plus the Pipelex build extensions.
 *
 * One base URL (`MTHDS_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare.
 * - **build extensions** (`/v1/build/*`) — the Pipelex API's spec-to-TOML / runner
 *   / inputs / output helpers.
 *
 * The durable run-lifecycle (poll a run by id: `getRunStatus` / `getRunResult` /
 * `waitForResult` / `startAndWaitForResult`) is NOT part of this client — it now
 * lives in the Pipelex runtime SDK (`@pipelex/sdk` / `pipelex-agent`).
 */
export class MthdsApiClient implements Runner {
  readonly type: RunnerType = Runners.API;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;

  constructor(options: MthdsApiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MTHDS_API_KEY;
    const normalizedBaseUrl = (
      options.baseUrl ??
      process.env.MTHDS_BASE_URL ??
      DEFAULT_API_BASE_URL
    ).replace(/\/+$/, "");
    // `config set base-url` validates host-only; direct SDK usage and
    // MTHDS_BASE_URL reach this constructor and must be held to the same rule,
    // or a path-prefixed value (e.g. `.../v1`) composes as `/v1/v1/...` and
    // fails with a misleading endpoint error instead of a clear base-URL one.
    // Trailing slashes are stripped first (leniency the SDK has always had);
    // a remaining path/query/fragment/credentials is rejected.
    if (!isValidBaseUrl(normalizedBaseUrl)) {
      throw new PipelineRequestError(
        `Invalid API base URL "${normalizedBaseUrl}": must be host-only ` +
          `(http/https, no path, query, fragment, or credentials). Endpoints ` +
          `compose as {base}/v1/{endpoint}.`,
      );
    }
    this.baseUrl = normalizedBaseUrl;
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
   * abort (Ctrl-C / agent walk-away) propagates as-is so a caller can stop
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
    } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    const hasBody = options.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out.", "TimeoutError")),
      timeoutMs,
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
      // A caller-initiated abort (not our timeout) propagates untouched so a
      // caller can distinguish "I stopped waiting" from a network failure.
      if (userSignal?.aborted) throw err;
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // Our timeout aborts the controller with a "TimeoutError" DOMException.
      const code = extractNetworkErrorCode(err);
      throw new ApiUnreachableError(
        `Could not reach Pipelex API at ${this.baseUrl} (${code ?? "network error"})`,
        this.baseUrl,
        code,
        { cause: err },
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
  private async requestJson<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
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
      throw new Error(`API ${method} ${url} failed (${res.status}): ${text || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  private postApi<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson("POST", this.url(path), body);
  }

  private throwApiResponseError(method: "GET" | "POST", endpoint: string, res: RawResponse): never {
    const { errorType, serverMessage, validationErrors } = parseErrorBody(res.body);
    throw new ApiResponseError(
      `API ${method} /${API_PREFIX}/${endpoint} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage,
      validationErrors,
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
        "running server-side. Resume by id via the durable run API " +
        "(`@pipelex/sdk` / `pipelex-agent`), or use start().",
      runId,
      parseRetryAfter(res.headers),
      res.headers.get("location"),
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
   * that exceeds that surfaces as `PipelineExecuteTimeoutError`. Throws
   * `RunStillRunningError` on the protocol's optional 202 degrade.
   */
  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents or a server-specific extension arg (extra) must be provided to execute().",
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
      // translate it into a clear, actionable error.
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
   * `pipeline_run_id` is always authoritative. How completion is later delivered
   * (durable polling, callbacks) is implementation-defined and outside this
   * client — the durable run-lifecycle lives in `@pipelex/sdk` / `pipelex-agent`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      Object.keys(extensions).length === 0
    ) {
      throw new PipelineRequestError(
        "Either pipe_code, mthds_contents or a server-specific extension arg (extra) must be provided to start().",
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

    const url = this.url("start");
    const res = await this.requestRaw("POST", url, {
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
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the protocol's neutral
   * `ValidationResult` union verbatim — `is_valid: true` ⇒ a `ValidationReport`,
   * `is_valid: false` ⇒ an `InvalidValidationReport` (`validation_errors[]`). The
   * Pipelex-API narrowing of both arms (the typed structural artifacts, the
   * closed-vocabulary `validation_errors[]`) lives in the runtime SDK
   * (`@pipelex/sdk`'s `PipelexValidationResult`), not in the standard's client.
   * An invalid bundle is NOT thrown — the caller pattern-matches `is_valid`. Only a
   * *no-verdict* condition (a malformed request, an `mthds_sources` length mismatch,
   * auth, a server fault) is non-2xx and surfaces as `ApiResponseError`.
   *
   * `mthdsSources` (optional, parallel to `mthdsContents`) names each submitted
   * content — a Pipelex-API extension threaded onto `blueprint.source`, so
   * cross-file diagnostics name the owning file (an unnamed content yields
   * `source: null`). The server 422s a length mismatch; this client sends the
   * arrays verbatim and surfaces that as an `ApiResponseError`.
   *
   * `render` is the Pipelex-API presentation hint — a list of view-format tokens.
   * This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more
   * tokens. Unknown tokens are server-side lenient-ignored (never a 422).
   */
  async validate(
    mthdsContents: string[],
    allowSignatures = false,
    mthdsSources?: string[],
    render?: string[],
  ): Promise<ValidationResult> {
    const body: Record<string, unknown> = {
      mthds_contents: mthdsContents,
      allow_signatures: allowSignatures,
    };
    if (mthdsSources !== undefined) {
      body.mthds_sources = mthdsSources;
    }
    body.render = withValidateMarkdownRender(render);
    const res = await this.requestRaw("POST", this.url("validate"), { body });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return JSON.parse(res.body) as ValidationResult;
  }

  /**
   * Validate paired MTHDS files while preserving URI attribution for diagnostics.
   *
   * This adapter intentionally keeps the low-level `validate(...)` payload shape
   * intact for existing consumers. When any file has a URI, every content gets a
   * parallel source label; inline labels are deterministic so the server never
   * sees a length-mismatched `mthds_sources` array.
   */
  async validateFiles(
    files: MthdsFile[],
    options: ValidateFilesOptions = {},
  ): Promise<ValidationResult> {
    if (files.length === 0) {
      throw new PipelineRequestError(
        "At least one MTHDS file must be provided to validateFiles().",
      );
    }

    const mthdsContents = files.map((file) => file.content);
    const hasAnyUri = files.some((file) => file.uri !== undefined);
    const mthdsSources = hasAnyUri
      ? files.map((file, index) => file.uri ?? `inline://file-${index + 1}.mthds`)
      : undefined;

    return this.validate(
      mthdsContents,
      options.allowSignatures ?? false,
      mthdsSources,
      options.render,
    );
  }

  /** The model deck the runner can route to — `GET /v1/models[?type=]`. */
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const endpoint = category ? `models?type=${encodeURIComponent(category)}` : "models";
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

  async buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse> {
    return this.postApi("build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<BuildOutputResponse> {
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

  // ── Storage convenience (NON-CONTRACT — `POST /v1/upload`) ─────────

  /**
   * Upload a file and get back the `pipelex-storage://` URI pipelex resolves at
   * runtime — `POST /v1/upload`.
   *
   * NON-CONTRACT: not part of the MTHDS Protocol nor the build extensions; a
   * deployment convenience slated for replacement by the storage redesign. Kept
   * off the `Runner` interface for that reason (a local pipelex runner has no
   * upload route). Goes through `requestRaw` + `throwApiResponseError` so an
   * auth/size/server failure surfaces as the same typed `ApiResponseError` the
   * protocol surface uses, not a bare `Error`.
   */
  async uploadFile(request: UploadFileRequest): Promise<UploadFileResult> {
    const body: Record<string, unknown> = {
      filename: request.filename,
      data: request.data,
    };
    if (request.contentType !== undefined) {
      body.content_type = request.contentType;
    }
    const res = await this.requestRaw("POST", this.url("upload"), { body });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "upload", res);
    }
    return JSON.parse(res.body) as UploadFileResult;
  }
}

// ── Module helpers ────────────────────────────────────────────────────

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
function buildExtensions(
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!extra) return {};
  const overlap = Object.keys(extra).filter((key) => PROTOCOL_REQUEST_KEYS.has(key));
  if (overlap.length > 0) {
    throw new PipelineRequestError(
      `extra carries protocol args [${overlap.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  return { ...extra };
}

function withValidateMarkdownRender(render: string[] | undefined): string[] {
  const formats = new Set(render ?? []);
  formats.add(VALIDATE_MARKDOWN_RENDER_FORMAT);
  return [...formats];
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

/** Parse the `Retry-After` header (seconds form, which the platform uses). */
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * The API serializes errors as `{"detail": {"error_type": ..., "message": ...}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s and RFC
 * 7807 problems). Both shapes are extracted here. An invalid-bundle 422 problem
 * additionally carries a top-level `validation_errors[]` list (the
 * `ValidateBundleError` extension projected onto the envelope). Falls through
 * silently on non-JSON bodies.
 */
function parseErrorBody(body: string): {
  errorType: string | undefined;
  serverMessage: string | undefined;
  validationErrors: ValidationErrorItem[] | undefined;
} {
  const empty = { errorType: undefined, serverMessage: undefined, validationErrors: undefined };
  if (!body) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") {
    return empty;
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
  // `validation_errors` rides the problem envelope as a top-level array (the
  // VERBOSE projection of `ErrorReport.validation_errors`, retained under STRICT
  // too — it describes the caller's own bundle, not server internals). Kept as a
  // shallow array guard; per-item shape is the typed `ValidationErrorItem` contract.
  const validationErrors = Array.isArray(root.validation_errors)
    ? (root.validation_errors as ValidationErrorItem[])
    : undefined;
  return { errorType, serverMessage, validationErrors };
}
