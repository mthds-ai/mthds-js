import { Runners } from "../types.js";
import type { Runner, RunnerType, PipeIORequest, PipeIOResponse } from "../types.js";
import type { RunOptions, RunRequest, StartOptions, StartRequest } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  RunResultStart,
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import type { DictRunResultExecute } from "./models.js";
import { ApiResponseError, ApiTransportError, RunStillRunningError } from "./exceptions.js";
import type { ApiAnswerFacts } from "./exceptions.js";
import { argumentInvalid, ProblemError } from "../../problems/errors.js";
import { buildProblem } from "../../problems/build.js";
import {
  isProblemItem,
  parseJsonBody,
  readErrorAnswer,
  readProblemBody,
  retryAfterSeconds,
  unreadableAnswer,
} from "../../problems/read.js";
import type { Problem } from "../../problems/types.js";
import { networkErrorCode, provesNothingSent } from "./transport.js";
import { isValidBaseUrl } from "../../config/config.js";
import { assertExclusiveRunSources, hasBundlePayload } from "../../protocol/options.js";
import { buildUserAgent } from "./user-agent.js";
import type { AppInfo } from "./user-agent.js";

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

export interface MthdsApiClientOptions {
  /** API key (Bearer). Falls back to `MTHDS_API_KEY`. Optional for anonymous bare runners. */
  apiKey?: string;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`. Falls back to `MTHDS_BASE_URL`, then the hosted
   * default.
   */
  baseUrl?: string;
  /**
   * The integrator's identity, placed in front of this library's tokens in the
   * `User-Agent` header (`acme-invoicer/1.4.0 mthds-js/0.26.0 node/22.4.0 (darwin; arm64)`).
   * Validated at construction: an invalid value throws `TypeError`.
   * See `docs/client-identification.md`.
   */
  appInfo?: AppInfo;
}

/** One route of the runtime, as the client calls it. */
interface Route {
  method: "GET" | "POST";
  /** The absolute URL. */
  url: string;
  /** How the route is named in an error: `POST /v1/execute`. */
  name: string;
  /** Whether a request to it creates a run, so that an answer lost after it left leaves the outcome unknown. */
  createsRun: boolean;
  /** The client's time limit for the whole exchange, the answer's body included. */
  timeoutMs: number;
}

/** What came back from the runtime, before the client reads it. */
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
// self-hosted pipelex-api runner (localhost:8081) — the protocol surface is identical.
const API_PREFIX = "v1";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single GETs (models/version/start); the hosted gateway caps responses at ~30s.
// A `method_ref` can make the server CLONE a repository before it answers, and on a
// cold cache that runs well past the static-route budget above. The same budget
// `@pipelex/sdk` gives its crate routes; inert on the hosted path, where the gateway
// caps a response at ~30s whatever the client allows.
const METHOD_REF_FETCH_TIMEOUT_MS = 180_000; // 3 min — covers the server's clone + resolve
const VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown";

/**
 * Client for any MTHDS runner — and THE API runner (parity D8). One class,
 * two consumers: `pipelex-app` instantiates it directly as a protocol client,
 * the CLI gets it via `createRunner()` as a full `Runner`. It carries the
 * protocol surface plus the Pipelex API's pipe I/O extension.
 *
 * One base URL (`MTHDS_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare.
 * - **`pipeIo`** (`/v1/pipe-io`) — a Pipelex API extension carrying the standard's
 *   I/O artifacts. It lives on this class and not on `Runner`: the local pipelex
 *   runner shells out and has no use for it.
 *
 * Every failure of every route, `health` included, is a `ProblemError` carrying a problem with a
 * registered code (see `exceptions.ts` and docs/errors.md): an answer that is not the route's
 * result is an `ApiResponseError`, a call that got no answer an `ApiTransportError`. The client
 * never repeats a request by itself, so a problem whose `retry` is `outcome_unknown` is never
 * retried here; a caller that retries reads `retry` first.
 *
 * The durable run-lifecycle (poll a run by id: `getRunStatus` / `getRunResult` /
 * `waitForResult` / `startAndWaitForResult`) is NOT part of this client — it now
 * lives in the Pipelex runtime SDK (`@pipelex/sdk`).
 */
export class MthdsApiClient implements Runner {
  readonly type: RunnerType = Runners.API;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  /**
   * `User-Agent` value computed once at construction; `undefined` in a browser,
   * where the header must not be set.
   */
  private readonly userAgent: string | undefined;

  constructor(options: MthdsApiClientOptions = {}) {
    // Validate appInfo first: a bad identity is an argument error regardless
    // of what the base URL resolves to.
    this.userAgent = buildUserAgent(options.appInfo);
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
      throw new ProblemError(
        buildProblem(
          "client.not_configured",
          { setting: "base_url" },
          {
            extra: {
              message:
                `Invalid API base URL "${normalizedBaseUrl}": must be host-only ` +
                `(http/https, no path, query, fragment, or credentials). Endpoints ` +
                `compose as {base}/v1/{endpoint}.`,
            },
          },
        ),
      );
    }
    this.baseUrl = normalizedBaseUrl;
    this.originUrl = new URL("/", this.baseUrl).origin;
  }

  // ── Routes ─────────────────────────────────────────────────────────

  /** A route under `<base>/v1/`. */
  private route(
    method: "GET" | "POST",
    endpoint: string,
    timeoutMs: number,
    createsRun = false,
  ): Route {
    const path = `/${API_PREFIX}/${endpoint.replace(/^\/+/, "")}`;
    return {
      method,
      url: `${this.baseUrl}${path}`,
      name: `${method} ${path}`,
      createsRun,
      timeoutMs,
    };
  }

  // ── Transport ──────────────────────────────────────────────────────

  /**
   * The ONE place request headers are built, so no request path can miss the
   * `User-Agent` (spec: client-identification, "Client obligations").
   */
  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.userAgent !== undefined) {
      headers["User-Agent"] = this.userAgent;
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Send one request and return what came back, its body read whole, within the route's time
   * limit. A call that gets no answer throws an `ApiTransportError` (see `transportProblem`).
   * Reading the answer is the caller's.
   */
  private async send(route: Route, options: { body?: unknown } = {}): Promise<RawResponse> {
    const hasBody = options.body !== undefined;
    let payload: string | undefined;
    if (hasBody) {
      try {
        payload = JSON.stringify(options.body);
      } catch (cause) {
        throw new ProblemError(
          buildProblem(
            "client.argument_invalid",
            { argument: "body", reason: "not_json" },
            { extra: { message: `The request body of ${route.name} cannot be written as JSON.` } },
          ),
          { cause },
        );
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out.", "TimeoutError"));
    }, route.timeoutMs);

    try {
      const response = await fetch(route.url, {
        method: route.method,
        headers: this.buildHeaders(hasBody),
        body: payload,
        signal: controller.signal,
      });
      const body = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body,
      };
    } catch (err) {
      throw new ApiTransportError(
        this.transportProblem(route, err, timedOut),
        { apiUrl: this.baseUrl, networkCode: networkErrorCode(err) },
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The problem of a call that got no answer, once its request may have left:
   *
   * - on a route that creates a run, every failure but one that proves nothing was sent leaves
   *   the outcome unknown (`client.outcome_unknown`): the connection lost, or the client's time
   *   limit;
   * - on any other route, the client's time limit is `client.timeout`, and a lost or refused
   *   connection is `client.unreachable`;
   * - a failure of the connection's set-up, which proves nothing was sent, is
   *   `client.unreachable` on every route.
   */
  private transportProblem(route: Route, err: unknown, timedOut: boolean): Problem {
    const unreachable = (): Problem =>
      buildProblem("client.unreachable", { base_url: this.baseUrl });
    if (!timedOut && provesNothingSent(err)) return unreachable();
    if (route.createsRun) return buildProblem("client.outcome_unknown", {});
    if (timedOut) return buildProblem("client.timeout", { seconds: route.timeoutMs / 1000 });
    return unreachable();
  }

  // ── Reading answers ─────────────────────────────────────────────────

  private answerFacts(route: Route, res: RawResponse, bodyIsProblem?: boolean): ApiAnswerFacts {
    const requestIdHeader = res.headers.get("x-request-id")?.trim();
    return {
      apiUrl: this.baseUrl,
      route: route.name,
      status: res.status,
      statusText: res.statusText,
      responseBody: res.body,
      requestIdHeader: requestIdHeader ? requestIdHeader : undefined,
      bodyIsProblem,
    };
  }

  /**
   * The route's result, when the answer is a `2xx` whose body is JSON of the route's shape;
   * otherwise the answer read as its problem, thrown as an `ApiResponseError`.
   */
  private readResult<T>(route: Route, res: RawResponse, isResult: (value: unknown) => boolean): T {
    if (res.status < 200 || res.status >= 300) {
      throw new ApiResponseError(
        readErrorAnswer(res, { createsRun: route.createsRun }),
        this.answerFacts(route, res, readProblemBody(res.body) !== undefined),
      );
    }
    const reading = parseJsonBody(res.body);
    if (!reading.ok || !isResult(reading.value)) {
      throw new ApiResponseError(unreadableAnswer(res.status), this.answerFacts(route, res, false));
    }
    return reading.value as T;
  }

  /**
   * The protocol's optional `202` degrade of a blocking execute: the runner accepted the run and
   * will not hold the connection, so the client stops following a run that has started
   * (`client.follow_failed`, naming it). A `202` that does not name its run leaves the outcome
   * unknown (`client.outcome_unknown`).
   */
  private acceptedAsynchronously(route: Route, res: RawResponse): ApiResponseError {
    const reading = parseJsonBody(res.body);
    const runId =
      reading.ok && isObject(reading.value) && typeof reading.value.pipeline_run_id === "string"
        ? reading.value.pipeline_run_id
        : "";
    const facts = this.answerFacts(route, res);
    if (runId === "") {
      return new ApiResponseError(buildProblem("client.outcome_unknown", {}), facts);
    }
    return new RunStillRunningError(
      buildProblem("client.follow_failed", { pipeline_run_id: runId }),
      {
        ...facts,
        runId,
        retryAfterSeconds: retryAfterSeconds(res.headers),
        location: res.headers.get("location") ?? undefined,
      },
    );
  }

  // ── Health ────────────────────────────────────────────────────────

  /** The runtime's health — `GET /health`, at the origin and not under `/v1`. */
  async health(): Promise<Record<string, unknown>> {
    const route: Route = {
      method: "GET",
      url: `${this.originUrl}/health`,
      name: "GET /health",
      createsRun: false,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    };
    return this.readResult(route, await this.send(route), isObject);
  }

  // ── Protocol surface ─────────────────────────────────────────────────

  /**
   * Execute a method synchronously and wait for its completion —
   * `POST /v1/execute`.
   *
   * A request that creates a run: a connection lost or a time limit reached once it left throws
   * an `ApiTransportError` of `client.outcome_unknown`, which no caller repeats automatically. A
   * `202` throws `RunStillRunningError` (`client.follow_failed`).
   */
  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(extensions).length === 0
    ) {
      throw argumentInvalid(
        "pipe_code",
        "missing",
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64) or a server-specific extension arg (extra) must be provided to execute().",
      );
    }
    assertExclusiveRunSources(options);

    const request: RunRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...extensions,
    };

    const route = this.route("POST", "execute", DEFAULT_REQUEST_TIMEOUT_MS, true);
    const res = await this.send(route, { body: request });
    if (res.status === 202) throw this.acceptedAsynchronously(route, res);
    return this.readResult(route, res, isRunResultExecute);
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * Server-specific extension args ride `options.extra` and merge into the
   * request body — the server you call defines and handles them (including a
   * client-supplied run id where a server supports one). The returned
   * `pipeline_run_id` is always authoritative. How completion is later delivered
   * (durable polling, callbacks) is implementation-defined and outside this
   * client — the durable run-lifecycle lives in `@pipelex/sdk`. A request that creates a run, so
   * an answer lost once it left is `client.outcome_unknown`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    if (
      !options.pipe_code &&
      (!options.mthds_contents || options.mthds_contents.length === 0) &&
      !hasBundlePayload(options) &&
      Object.keys(extensions).length === 0
    ) {
      throw argumentInvalid(
        "pipe_code",
        "missing",
        "Either pipe_code, mthds_contents, a method bundle (files/bundle_b64) or a server-specific extension arg (extra) must be provided to start().",
      );
    }
    assertExclusiveRunSources(options);

    // `?? undefined` so JSON.stringify drops absent fields from the wire body.
    const request: StartRequest & Record<string, unknown> = {
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
      files: nonEmptyFiles(options.files),
      bundle_b64: nonEmptyString(options.bundle_b64),
      ...extensions,
    };

    const route = this.route("POST", "start", POLL_REQUEST_TIMEOUT_MS, true);
    return this.readResult(route, await this.send(route, { body: request }), isRunResultStart);
  }

  /**
   * Parse, validate, and dry-run an MTHDS bundle — `POST /v1/validate`.
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the protocol's `ValidationResult` union verbatim —
   * `is_valid: true` ⇒ a `ValidationReport`, `is_valid: false` ⇒ an `InvalidValidationReport`,
   * whose `errors` are problem items. An invalid bundle is NOT thrown — the caller
   * pattern-matches `is_valid`. Only a *no-verdict* condition (a malformed request, an
   * `mthds_sources` length mismatch, auth, a server fault) is non-2xx and surfaces as
   * `ApiResponseError`.
   *
   * `mthdsSources` (optional, parallel to `mthdsContents`) names each submitted
   * content — a Pipelex-API extension, so cross-file diagnostics name the owning file in their
   * location. The server 422s a length mismatch; this client sends the arrays verbatim.
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
    const route = this.route("POST", "validate", DEFAULT_REQUEST_TIMEOUT_MS);
    return this.readResult(route, await this.send(route, { body }), isVerdict);
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
      throw argumentInvalid(
        "files",
        "empty",
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
    const route = this.route("GET", endpoint, POLL_REQUEST_TIMEOUT_MS);
    return this.readResult(route, await this.send(route), isModelDeck);
  }

  /**
   * Protocol + implementation versions — `GET /v1/version` (always public).
   * The handshake for feature detection (hosted extensions or not).
   */
  async version(): Promise<VersionInfo> {
    const route = this.route("GET", "version", POLL_REQUEST_TIMEOUT_MS);
    return this.readResult(route, await this.send(route), isVersionInfo);
  }

  // ── Pipe I/O (Pipelex API extension — `POST /v1/pipe-io`) ─────────

  /**
   * Read a method's three I/O artifacts — `POST /v1/pipe-io`.
   *
   * Resolves the closure through the server's static core, selects a pipe, and
   * returns its pipe I/O contracts, input form and output form (the MTHDS standard's
   * artifacts, typed from `mthds/protocol`) beside the resolved `pipe_ref`, the
   * method's own `default_pipe_ref` and the runnability facts. It runs no dry run, so
   * it costs one load and one derivation where `validate` dry-runs every pipe.
   *
   * Returns a **200 verdict**: pattern-match `is_valid` before reading the arm. A
   * closure that does not load comes back as `is_valid: false` with its `errors`, problem items,
   * never as a throw. Only a no-verdict condition throws an `ApiResponseError`: a malformed
   * selector, an over-limit file and a refused pipe selection are `422`s (a selection refusal is
   * coded by one of `PIPE_SELECTION_CODES`), a registry-form `method_ref` is a `501`, and an
   * artifact that cannot be derived is a `500`.
   *
   * The request is posted as given, `method_id` included, and the selector XOR is the
   * server's to enforce. A `method_ref` gets the fetch-sized budget; every other
   * request gets the static-route one.
   */
  async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
    const route = this.route("POST", "pipe-io", crateRequestTimeoutMs(request));
    return this.readResult(route, await this.send(route, { body: request }), isVerdict);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The base of `POST /execute`'s result: the run's id and its output. */
function isRunResultExecute(value: unknown): boolean {
  return (
    isObject(value) && typeof value.pipeline_run_id === "string" && isObject(value.pipe_output)
  );
}

/** The base of `POST /start`'s result: the run's id. */
function isRunResultStart(value: unknown): boolean {
  return isObject(value) && typeof value.pipeline_run_id === "string";
}

/**
 * A verdict, of `/validate` or `/pipe-io`: discriminated on `is_valid`, an invalid one holding its
 * faults in `errors`, each an item of the protocol's shape, so a caller reads every item by its
 * `code` and `detail`.
 */
function isVerdict(value: unknown): boolean {
  if (!isObject(value) || typeof value.is_valid !== "boolean") return false;
  if (value.is_valid) return true;
  return Array.isArray(value.errors) && value.errors.every(isProblemItem);
}

/** The base of `GET /models`'s result: the list of models. */
function isModelDeck(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.models);
}

/** The base of `GET /version`'s result: the protocol version the runner implements. */
function isVersionInfo(value: unknown): boolean {
  return isObject(value) && typeof value.protocol_version === "string";
}

// The protocol's own request fields — `extra` is for extension args only.
// `files` / `bundle_b64` are reserved too: they are named run-source options,
// so smuggling them through `extra` (which merges last into the body) would
// overwrite the validated fields and bypass the run-source exclusivity check.
const PROTOCOL_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "pipe_code",
  "mthds_contents",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "files",
  "bundle_b64",
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
    throw argumentInvalid(
      "extra",
      "protocol_arg",
      `extra carries protocol args [${overlap.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  return { ...extra };
}

/**
 * Normalize a bundle encoding for the wire: an empty map / string is NOT a
 * runnable bundle, so it must not be sent (the runner rejects a zero-file
 * bundle). Exclusivity is still checked on presence upstream, so an empty
 * encoding supplied alongside another source has already been rejected.
 */
function nonEmptyFiles(
  files: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  return files != null && Object.keys(files).length > 0 ? files : undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
}

/**
 * The request budget for a crate-route call: the fetch-sized one when the closure
 * is a `method_ref` the server may have to clone first, the static-route one
 * otherwise.
 */
function crateRequestTimeoutMs(request: { method_ref?: string }): number {
  return nonEmptyString(request.method_ref) !== undefined
    ? METHOD_REF_FETCH_TIMEOUT_MS
    : POLL_REQUEST_TIMEOUT_MS;
}

function withValidateMarkdownRender(render: string[] | undefined): string[] {
  const formats = new Set(render ?? []);
  formats.add(VALIDATE_MARKDOWN_RENDER_FORMAT);
  return [...formats];
}
