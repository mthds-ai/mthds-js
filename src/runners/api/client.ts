import { Runners } from "../types.js";
import type { Runner, RunnerType, PipeIORequest, PipeIOResponse } from "../types.js";
import type {
  RunOptions,
  RunRequest,
  StartOptions,
  ValidateSource,
} from "../../protocol/options.js";
import type { MethodFiles, MethodTreeSource } from "../../protocol/file_entries.js";
import type {
  MissingBlob,
  MissingBlobsRequest,
  MissingBlobsResult,
  ModelCategory,
  ModelDeck,
  RunResultStart,
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import type { MethodTreeLimits } from "../../method-tree/lister.js";
import type { DictRunResultExecute } from "./models.js";
import {
  ApiResponseError,
  ApiTransportError,
  BlobUploadError,
  MalformedBlobsAnswerError,
  RunStillRunningError,
} from "./exceptions.js";
import type { ApiAnswerFacts } from "./exceptions.js";
import { PipelineRequestError } from "../../protocol/exceptions.js";
import { argumentInvalid, problemError } from "../../problems/errors.js";
import type { ProblemError } from "../../problems/errors.js";
import { buildProblem } from "../../problems/build.js";
import {
  isObject,
  isProblemItem,
  parseJsonBody,
  readAnswer,
  readProblemBody,
  retryAfterSeconds,
  unreadableAnswer,
} from "../../problems/read.js";
import type { JsonReading } from "../../problems/read.js";
import type { Problem } from "../../problems/types.js";
import { networkErrorCode, provesNothingSent } from "./transport.js";
import { isValidBaseUrl } from "../../config/config.js";
import { assertOneMethodSource, hasMethodSource } from "../../protocol/options.js";
import { buildUserAgent } from "./user-agent.js";
import type { AppInfo } from "./user-agent.js";
import {
  INLINE_TREE_MAX_BYTES,
  announcedTreeLimits,
  declaresBlobStore,
  fileByBlob,
  forEachConcurrently,
  hashMethodFiles,
  inlineFilesOf,
  inlineMapBytes,
  listerLimitsOf,
  mightTravelInline,
  treeTotalSize,
  uniqueBlobs,
} from "./tree-sending.js";

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
  /**
   * Whether no error may quote what the route answers, as for `POST /blobs/missing`, whose answers
   * name upload targets by presigned URLs.
   */
  withholdsBody?: boolean;
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

/**
 * An API key the `Authorization` header carries as written: visible ASCII characters only, so no
 * whitespace at either end, which fetch would trim, no line break or NUL, which fetch refuses, and
 * nothing past ASCII. The Python twin holds a key to the same rule.
 */
const SENDABLE_API_KEY = /^[!-~]+$/;

const DEFAULT_REQUEST_TIMEOUT_MS = 1_200_000; // 20 min — matches the runner's blocking execute ceiling.
const POLL_REQUEST_TIMEOUT_MS = 30_000; // single GETs (models/version/start); the hosted gateway caps responses at ~30s.
// A `method_ref` can make the server CLONE a repository before it answers, and on a
// cold cache that runs well past the static-route budget above. The same budget
// `@pipelex/sdk` gives its crate routes; inert on the hosted path, where the gateway
// caps a response at ~30s whatever the client allows.
const METHOD_REF_FETCH_TIMEOUT_MS = 180_000; // 3 min — covers the server's clone + resolve
const VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown";
// One blob of up to the runner's file limit (tens of MiB on the hosted plane) per request.
const BLOB_UPLOAD_TIMEOUT_MS = 300_000; // 5 min
// Uploads run side by side, a few at a time, so a tree of many small files is not sent one by one.
const BLOB_UPLOAD_CONCURRENCY = 4;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * How long a runner's handshake is trusted before the client asks again. A runner's
 * blob store and tree limits change only with a deploy, so a client asks once per
 * this span rather than before every request; a refusal that says the answer is
 * stale (`/blobs/missing` gone, a tree refused as too large) drops it sooner.
 */
export const HANDSHAKE_TTL_MS = 5 * 60_000;

/**
 * How a runner refuses a tree past one of its limits, on a run, a validation or a pipe I/O
 * read. The standard asks for "a problem naming the limit": the core registry's
 * `method.package_invalid` with its `limit` parameter, which that code carries only when the rule
 * the tree breaks is a limit. The client also reads the two runners that sent one before the
 * registry: the hosted platform's problem `code` (with its `limit: {name, value, reached}`), and
 * pipelex-api's `error_type`, which the platform also relays when the runner behind it refuses the
 * tree.
 */
const PACKAGE_INVALID_CODE = "method.package_invalid";
/** The code of a refusal listing, in `params.missing_blobs`, the hash entries the runner lacks. */
const BLOBS_MISSING_CODE = "request.blobs_missing";
const METHOD_TREE_TOO_LARGE_CODE = "method_tree_too_large";
const METHOD_TREE_TOO_LARGE_ERROR_TYPE = "MethodTreeTooLarge";

/** The `files` map a request carries, and the tree behind it when it travels by hash. */
interface PreparedFiles {
  files: MethodFiles | undefined;
  /**
   * The tree, when the client sent it by hash: a `422` naming `missing_blobs` is then
   * answered by uploading them and resending, since the client holds their bytes.
   */
  byHashTree: MethodTreeSource | undefined;
}

/**
 * The bytes of a tree's files already read for one request, by tree path, so a file
 * read to weigh the inline map is not read again to be uploaded or resent.
 */
type ReadBytes = Map<string, Uint8Array>;

/**
 * The run an answer's body names: its `pipeline_run_id` when that is an identifier, the
 * registry's type for a run id, a string, and not an empty one; else `undefined`.
 */
function runIdOf(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const runId = body.pipeline_run_id;
  return typeof runId === "string" && runId !== "" ? runId : undefined;
}

/**
 * The problem of a request that created a run or may have, with no result the client can read:
 * `client.outcome_unknown`, naming the run, as its parameter and as the problem's member, when
 * the answer names one.
 */
function outcomeUnknown(runId: string | undefined): Problem {
  if (runId === undefined) return buildProblem("client.outcome_unknown", {});
  return buildProblem(
    "client.outcome_unknown",
    { pipeline_run_id: runId },
    { pipeline_run_id: runId },
  );
}

/**
 * Client for any MTHDS runner — and THE API runner (parity D8). One class,
 * two consumers: `pipelex-app` instantiates it directly as a protocol client,
 * the CLI gets it via `createRunner()` as a full `Runner`. It carries the
 * protocol surface plus the Pipelex API's pipe I/O extension.
 *
 * One base URL (`MTHDS_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
 * - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — works
 *   against any MTHDS-compliant runner, hosted or bare. A method travels as its
 *   tree: given as `tree`, the client sends it inline, or by hash through the
 *   optional blob routes (`findMissingBlobs`, `uploadBlob`) when the runner
 *   declares a blob store and the tree is large.
 * - **`pipeIo`** (`/v1/pipe-io`) — a Pipelex API extension carrying the standard's
 *   I/O artifacts, which takes the method's tree as the protocol routes do. It lives
 *   on this class and not on `Runner`: the local pipelex runner shells out and has
 *   no use for it.
 *
 * Every failure of every route, `health` included, is a `ProblemError` carrying a problem with a
 * registered code (see `exceptions.ts` and docs/errors.md): an answer that is not the route's
 * result is an `ApiResponseError`, a call that got no answer an `ApiTransportError`. These failures
 * of sending a tree by hash carry no problem yet: a failed upload of a blob to the target a runner
 * named, a `BlobUploadError`, and a `/blobs/missing` answer naming a blob the tree does not hold,
 * a `PipelineRequestError`. The client never repeats a request whose outcome it does not know, so a problem whose `retry` is
 * `outcome_unknown` is never retried here; a caller that retries reads `retry` first. It sends a
 * request carrying a method a second time only after a `422` refusal, which created nothing: once
 * after uploading the blobs a `request.blobs_missing` problem lists, and once after a tree refused
 * as past one of the runner's limits, on a fresh handshake.
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
  /** The runner's handshake and when it was asked, kept for `HANDSHAKE_TTL_MS`. */
  private handshakeCache: { promise: Promise<VersionInfo>; askedAt: number } | undefined;

  constructor(options: MthdsApiClientOptions = {}) {
    // Validate appInfo first: a bad identity is an argument error regardless
    // of what the base URL resolves to.
    this.userAgent = buildUserAgent(options.appInfo);
    this.apiKey = options.apiKey ?? process.env.MTHDS_API_KEY;
    // A key the `Authorization` header cannot carry as written would be refused, or silently
    // trimmed, at every request, which no repeat changes. The key is never quoted, nor is any
    // error that could quote it kept as a cause.
    if (this.apiKey && !SENDABLE_API_KEY.test(this.apiKey)) {
      throw problemError(
        "client.not_configured",
        { setting: "api_key" },
        {
          message:
            "The API key holds a character an HTTP header cannot carry, such as a line break or " +
            "a space at its end. Set it to the key alone.",
        },
      );
    }
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
      throw problemError(
        "client.not_configured",
        { setting: "base_url" },
        {
          message:
            `Invalid API base URL "${normalizedBaseUrl}": must be host-only ` +
            `(http/https, no path, query, fragment, or credentials). Endpoints ` +
            `compose as {base}/v1/{endpoint}.`,
        },
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
  /** The request's headers, the API key among them, which the constructor checked. */
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
   * Reading the answer is the caller's. On a route that creates a run, a redirect is not followed
   * but returned as the answer, which reads as `client.response_unreadable` naming its status.
   */
  private async send(route: Route, options: { body?: unknown } = {}): Promise<RawResponse> {
    const hasBody = options.body !== undefined;
    let payload: string | undefined;
    if (hasBody) {
      try {
        payload = JSON.stringify(options.body);
      } catch (cause) {
        throw problemError(
          "client.argument_invalid",
          { argument: "body", reason: "not_json" },
          { message: `The request body of ${route.name} cannot be written as JSON.`, cause },
        );
      }
    }
    // Built before the request, so that a header fetch refuses is never read as a transport failure.
    const headers = this.buildHeaders(hasBody);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out.", "TimeoutError"));
    }, route.timeoutMs);

    try {
      const response = await fetch(route.url, {
        method: route.method,
        headers,
        body: payload,
        // A request that creates a run is never sent twice, so a redirect is an answer to read
        // rather than a second request to make: following it would send the request again, and a
        // failure to reach the redirect's target would read as a runtime never reached although
        // the request had reached one.
        redirect: route.createsRun ? "manual" : "follow",
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
      // Whatever failed, the request is given up: aborting it releases the connection and the
      // answer's body, should it have started arriving before the failure, as when reading it
      // fails half way.
      controller.abort();
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
      withholdBody: route.withholdsBody,
    };
  }

  /**
   * The route's result, when the answer is a `2xx` whose body is JSON of the route's shape;
   * otherwise the answer read as its problem, thrown as an `ApiResponseError`. A `2xx` that is not
   * the route's result reads as `client.response_unreadable`, except on a route that creates a run,
   * where the runtime accepted the request and the run may exist: there it reads as
   * `client.outcome_unknown`, naming the run whenever the body names one.
   */
  private readResult<T>(route: Route, res: RawResponse, isResult: (value: unknown) => boolean): T {
    if (res.status < 200 || res.status >= 300) throw this.refusal(route, res);
    const reading = parseResultBody(res.body);
    if (!reading.ok || !isResult(reading.value)) {
      const problem = route.createsRun
        ? outcomeUnknown(reading.ok ? runIdOf(reading.value) : undefined)
        : unreadableAnswer(res.status);
      throw new ApiResponseError(problem, this.answerFacts(route, res, false));
    }
    return reading.value as T;
  }

  /** An answer outside `2xx`, read as its problem (`readAnswer`). */
  private refusal(route: Route, res: RawResponse): ApiResponseError {
    const { problem, fromBody } = readAnswer(res, { createsRun: route.createsRun });
    return new ApiResponseError(problem, this.answerFacts(route, res, fromBody));
  }

  /**
   * The protocol's optional `202` degrade of a blocking execute: the runner accepted the run and
   * will not hold the connection, so the client stops following a run that has started
   * (`client.follow_failed`, naming it). A `202` that does not name its run leaves the outcome
   * unknown (`client.outcome_unknown`); its body is no problem document, so the error quotes its
   * start (`answerExcerpt`), as `readResult` quotes a success that is not the route's result.
   */
  private acceptedAsynchronously(route: Route, res: RawResponse): ApiResponseError {
    const reading = parseResultBody(res.body);
    const runId = reading.ok ? runIdOf(reading.value) : undefined;
    if (runId === undefined) {
      return new ApiResponseError(outcomeUnknown(undefined), this.answerFacts(route, res, false));
    }
    const facts = this.answerFacts(route, res);
    // The run exists, so the problem names it as its `pipeline_run_id` member as well.
    return new RunStillRunningError(
      buildProblem("client.follow_failed", { pipeline_run_id: runId }, { pipeline_run_id: runId }),
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
   * The method travels as `files`, the map sent as given, or as `tree`, which the
   * client sends inline or by hash (see `prepareMethodFiles`). Sent by hash, a
   * `422` coded `request.blobs_missing` is answered by uploading the blobs it lists and resending
   * once.
   *
   * A request that creates a run: a connection lost or a time limit reached once it left throws
   * an `ApiTransportError` of `client.outcome_unknown`, which no caller repeats automatically. A
   * `202` throws `RunStillRunningError` (`client.follow_failed`).
   */
  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const extensions = buildExtensions(options.extra);
    assertOneMethodSource(options);
    assertRunnable(options, extensions, "execute");

    const route = this.route("POST", "execute", DEFAULT_REQUEST_TIMEOUT_MS, true);
    const res = await this.postMethodRequest(route, options, (files) =>
      runRequestBody(options, files, extensions),
    );
    if (res.status === 202) throw this.acceptedAsynchronously(route, res);
    return this.readResult(route, res, isRunResultExecute);
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * The method travels as `execute` sends it. Server-specific extension args ride
   * `options.extra` and merge into the request body — the server you call defines
   * and handles them (including a client-supplied run id where a server supports
   * one). The returned `pipeline_run_id` is always authoritative. How completion is
   * later delivered (durable polling, callbacks) is implementation-defined and
   * outside this client — the durable run-lifecycle lives in `@pipelex/sdk`. A request that
   * creates a run, so an answer lost once it left is `client.outcome_unknown`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    assertOneMethodSource(options);
    assertRunnable(options, extensions, "start");

    const route = this.route("POST", "start", POLL_REQUEST_TIMEOUT_MS, true);
    const res = await this.postMethodRequest(route, options, (files) =>
      runRequestBody(options, files, extensions),
    );
    return this.readResult(route, res, isRunResultStart);
  }

  /**
   * Parse, validate, and dry-run a method — `POST /v1/validate`.
   *
   * The method travels as its whole tree: `{ files }`, the map sent as given, or
   * `{ tree }`, which the client sends inline or by hash as it does for a run. The
   * runner judges every bundle and every file a bundle names, and attributes each
   * fault to its file by tree path (the item's `location.file`).
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the protocol's `ValidationResult` union verbatim —
   * `is_valid: true` ⇒ a `ValidationReport`, `is_valid: false` ⇒ an `InvalidValidationReport`,
   * whose `errors` are problem items. An invalid method is NOT thrown — the caller
   * pattern-matches `is_valid`. Only a *no-verdict* condition (a malformed request, a tree the
   * runner refuses, auth, a server fault) is non-2xx and surfaces as `ApiResponseError`.
   *
   * `render` is the Pipelex-API presentation hint — a list of view-format tokens.
   * This client always asks for Markdown so both valid results and produced
   * validation-error verdicts carry `rendered_markdown`; callers may add more
   * tokens. Unknown tokens are server-side lenient-ignored (never a 422).
   */
  async validate(
    source: ValidateSource,
    allowSignatures = false,
    render?: string[],
  ): Promise<ValidationResult> {
    assertOneMethodSource(source);
    if (!hasMethodSource(source)) {
      throw argumentInvalid(
        "files",
        "missing",
        "validate() needs the method's tree, as files or tree.",
      );
    }
    const route = this.route("POST", "validate", DEFAULT_REQUEST_TIMEOUT_MS);
    const res = await this.postMethodRequest(route, source, (files) => ({
      files,
      allow_signatures: allowSignatures,
      render: withValidateMarkdownRender(render),
    }));
    return this.readResult(route, res, isVerdict);
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

  // ── Sending a method tree ─────────────────────────────────────────

  /**
   * The limits this runner announces for a tree, as `listMethodTree` takes them,
   * so a lister stops at the first breach before it hashes anything: the hosted
   * platform's `limits.method_tree` member of `GET /v1/version`. Empty when the
   * runner announces none; no limit is ever assumed.
   */
  async methodTreeLimits(): Promise<MethodTreeLimits> {
    return listerLimitsOf(announcedTreeLimits(await this.handshake()));
  }

  /**
   * The `files` map to send for a tree, after uploading what the runner lacks. The
   * whole tree travels inline when the runner keeps no blob store, or when its
   * inline map, serialized as JSON in UTF-8, weighs 256 KiB or less
   * (`INLINE_TREE_MAX_BYTES`) and no more than the inline limit the runner
   * announces; otherwise every file travels by hash, after
   * `POST /v1/blobs/missing` with the tree's digest and the upload of each blob it
   * names. `execute`, `start`, `validate` and `pipeIo` call it for a `tree`; a
   * caller building its own request calls it directly.
   */
  async prepareMethodFiles(tree: MethodTreeSource): Promise<MethodFiles> {
    assertOneMethodSource({ tree });
    const prepared = await this.prepareTree(tree, new Map());
    return prepared.files!;
  }

  /**
   * Which of these blobs the runner lacks, and where to upload each —
   * `POST /v1/blobs/missing`, the protocol's optional route, served by a runner
   * whose `GET /v1/version` declares `blob_store: true`. A blob the runner holds is
   * left out, and an empty `missing` means there is nothing to upload. An answer that is not a
   * success throws an `ApiResponseError`; a success whose body is not shaped as the protocol says
   * throws a `MalformedBlobsAnswerError`, which never quotes the body, since its upload URLs are
   * bearer capabilities.
   */
  async findMissingBlobs(request: MissingBlobsRequest): Promise<MissingBlobsResult> {
    // Its answers name each upload target by a presigned URL, so no error ever quotes them.
    const route: Route = {
      ...this.route("POST", "blobs/missing", POLL_REQUEST_TIMEOUT_MS),
      withholdsBody: true,
    };
    const res = await this.send(route, { body: request });
    if (res.status < 200 || res.status >= 300) throw this.refusal(route, res);
    const reading = parseResultBody(res.body);
    if (!reading.ok) {
      throw new MalformedBlobsAnswerError(
        "POST /v1/blobs/missing answered a body that is not JSON.",
        res.status,
      );
    }
    const parsed = reading.value;
    const missing = isObject(parsed) ? parsed.missing : undefined;
    if (!Array.isArray(missing)) {
      throw new MalformedBlobsAnswerError(
        "POST /v1/blobs/missing answered without a `missing` list, which the protocol requires.",
        res.status,
      );
    }
    missing.forEach((entry: unknown, index) => {
      const fault = missingBlobFault(entry);
      if (fault !== null) {
        const sha256 = isObject(entry) && typeof entry.sha256 === "string" ? entry.sha256 : "";
        const wellFormed = SHA256_HEX.test(sha256) ? sha256 : undefined;
        const named = wellFormed === undefined ? "" : ` (blob ${wellFormed})`;
        throw new MalformedBlobsAnswerError(
          `POST /v1/blobs/missing answered a malformed entry at missing[${index}]${named}: ${fault}.`,
          res.status,
          index,
          wellFormed,
        );
      }
    });
    return parsed as unknown as MissingBlobsResult;
  }

  /**
   * Upload one blob's bytes to the target `findMissingBlobs` named: its bytes as the
   * whole body of a request with the target's method to its URL, carrying exactly
   * its headers. No credential is sent: the target authorizes the upload itself, by
   * a signed URL. The `User-Agent` is added only when the target is this runner's
   * own origin, since a third party's object store is not the API. A `412` means
   * the bytes are already held and counts as uploaded. Throws `BlobUploadError`,
   * which never carries the target URL, a bearer capability.
   */
  async uploadBlob(
    blob: MissingBlob,
    bytes: Uint8Array,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const { sha256, upload } = blob;
    let target: URL;
    try {
      target = new URL(upload.url);
    } catch {
      throw new BlobUploadError(
        `The upload target of blob ${sha256} is not a URL.`,
        sha256,
        undefined,
        "",
      );
    }
    const headers: Record<string, string> = { ...upload.headers };
    const namesUserAgent = Object.keys(headers).some((name) => name.toLowerCase() === "user-agent");
    if (this.userAgent !== undefined && target.origin === this.originUrl && !namesUserAgent) {
      headers["User-Agent"] = this.userAgent;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Upload timed out.", "TimeoutError"));
    }, BLOB_UPLOAD_TIMEOUT_MS);
    // A caller's signal, such as another upload of the same tree having failed, stops this one.
    const callerSignal = options.signal;
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted === true) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let response: Response;
    try {
      response = await fetch(upload.url, {
        method: upload.method,
        headers,
        body: bytes as Uint8Array<ArrayBuffer>,
        signal: controller.signal,
      });
      await response.arrayBuffer().catch(() => undefined);
    } catch (err) {
      // Only the network code is kept: the fetch error itself can quote the URL, its
      // signed query and any credentials written in it.
      const code =
        callerSignal?.aborted === true
          ? "stopped"
          : timedOut
            ? "ABORT_TIMEOUT"
            : (networkErrorCode(err) ?? "network error");
      throw new BlobUploadError(
        `Could not upload blob ${sha256} to ${target.host} (${code}).`,
        sha256,
        undefined,
        target.host,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
    if (response.ok || response.status === 412) return;
    throw new BlobUploadError(
      `Uploading blob ${sha256} to ${target.host} failed (${response.status} ${response.statusText}).`.trimEnd(),
      sha256,
      response.status,
      target.host,
    );
  }

  /**
   * The runner's handshake, asked once per `HANDSHAKE_TTL_MS`; a failed ask is not
   * kept, so the next call asks again.
   */
  private handshake(): Promise<VersionInfo> {
    const now = Date.now();
    const cached = this.handshakeCache;
    if (cached !== undefined && now - cached.askedAt < HANDSHAKE_TTL_MS) return cached.promise;
    const promise: Promise<VersionInfo> = this.version().catch((err: unknown) => {
      if (this.handshakeCache?.promise === promise) this.handshakeCache = undefined;
      throw err;
    });
    this.handshakeCache = { promise, askedAt: now };
    return promise;
  }

  /** Drop the kept handshake, which a refusal has shown to be stale. */
  private forgetHandshake(): void {
    this.handshakeCache = undefined;
  }

  /**
   * Post a request carrying a method: prepare its `files` (a `tree` sent inline or by
   * hash, a `files` map as given), post it, and answer a `422` coded `request.blobs_missing`
   * (see `postWithBlobRetry`). When a run, a validation or a pipe I/O read refuses a
   * tree the client prepared as past one of the runner's limits (`isMethodTreeTooLarge`), the
   * limits the handshake announced may be stale, so the client asks the handshake again, prepares
   * the tree as the fresh limits say and sends it once more: a `422` created nothing, so the
   * second request is no repeat of one whose outcome is unknown.
   */
  private async postMethodRequest(
    route: Route,
    method: RunOptions,
    body: (files: MethodFiles | undefined) => unknown,
  ): Promise<RawResponse> {
    const read: ReadBytes = new Map();
    const send = async (): Promise<RawResponse> => {
      const prepared = await this.prepareRequestFiles(method, read);
      return this.postWithBlobRetry(route, body(prepared.files), prepared, read);
    };
    const res = await send();
    if (method.tree == null || !isMethodTreeTooLarge(res)) return res;
    this.forgetHandshake();
    return send();
  }

  /** The `files` a request carries: `tree` prepared, `files` as given, or none. */
  private async prepareRequestFiles(options: RunOptions, read: ReadBytes): Promise<PreparedFiles> {
    if (options.tree != null) return this.prepareTree(options.tree, read);
    return { files: options.files ?? undefined, byHashTree: undefined };
  }

  /**
   * Choose how a tree travels, upload what it needs, and give the map to send. A file
   * is read at most once per request: what was read to weigh the inline map is what an
   * upload sends. When `/blobs/missing` answers `404`, the handshake that declared a
   * blob store is stale, so it is asked again and the tree prepared once more.
   */
  private async prepareTree(
    tree: MethodTreeSource,
    read: ReadBytes,
    retried = false,
  ): Promise<PreparedFiles> {
    const version = await this.handshake();
    const { maxInlineBytes } = announcedTreeLimits(version);
    if (!declaresBlobStore(version)) {
      return { files: await this.inlineWithin(tree, read, maxInlineBytes), byHashTree: undefined };
    }
    const inlineLimit = Math.min(INLINE_TREE_MAX_BYTES, maxInlineBytes ?? Infinity);
    // Raw sizes rule out a large tree without reading it; a tree that may fit is read
    // and weighed as the request would carry it.
    if (mightTravelInline(tree, inlineLimit)) {
      const inline = inlineFilesOf(tree, await readAll(tree, read));
      if (inlineMapBytes(inline) <= inlineLimit) {
        return { files: inline, byHashTree: undefined };
      }
    }
    let answer: MissingBlobsResult;
    try {
      answer = await this.findMissingBlobs({ digest: tree.digest, blobs: uniqueBlobs(tree) });
    } catch (err) {
      if (!retried && err instanceof ApiResponseError && err.status === 404) {
        this.forgetHandshake();
        return this.prepareTree(tree, read, true);
      }
      throw err;
    }
    await this.uploadMissing(tree, answer.missing, read);
    return { files: hashMethodFiles(tree), byHashTree: tree };
  }

  /**
   * The whole tree inline, for a runner with no blob store, held to the inline limit it
   * announces: its raw sizes are checked before anything is read, since the map weighs
   * at least that much, then the encoded map, so a tree the runner would refuse is
   * refused here, naming the limit, without being sent.
   */
  private async inlineWithin(
    tree: MethodTreeSource,
    read: ReadBytes,
    maxInlineBytes: number | undefined,
  ): Promise<MethodFiles> {
    if (maxInlineBytes !== undefined && treeTotalSize(tree) > maxInlineBytes) {
      throw inlineLimitError(treeTotalSize(tree), maxInlineBytes, "its files alone weigh");
    }
    const inline = inlineFilesOf(tree, await readAll(tree, read));
    if (maxInlineBytes !== undefined) {
      const weight = inlineMapBytes(inline);
      if (weight > maxInlineBytes) {
        throw inlineLimitError(weight, maxInlineBytes, "its inline map weighs");
      }
    }
    return inline;
  }

  /**
   * Upload each missing blob from the tree's bytes, a few at a time, stopping at the
   * first failure. A blob the tree does not hold is refused before anything is sent.
   */
  private async uploadMissing(
    tree: MethodTreeSource,
    missing: readonly MissingBlob[],
    read: ReadBytes,
  ): Promise<void> {
    const byBlob = fileByBlob(tree);
    const stranger = missing.find((blob) => !byBlob.has(blob.sha256));
    if (stranger !== undefined) {
      throw new PipelineRequestError(
        `The runner asked for blob ${stranger.sha256}, which is not a file of the tree being sent.`,
      );
    }
    await forEachConcurrently(missing, BLOB_UPLOAD_CONCURRENCY, async (blob, signal) => {
      const file = byBlob.get(blob.sha256)!;
      const bytes = read.get(file.path) ?? (await tree.readFile(file.path));
      await this.uploadBlob(blob, bytes, { signal });
    });
  }

  /**
   * Post a request whose method may have travelled by hash. When it did and the
   * runner answers a `422` coded `request.blobs_missing` whose `params.missing_blobs` the tree
   * holds, such as a blob dropped since the check, the client asks where to upload them, uploads
   * them and sends the same request once more, which the refusal left uncreated.
   */
  private async postWithBlobRetry(
    route: Route,
    body: unknown,
    prepared: PreparedFiles,
    read: ReadBytes,
  ): Promise<RawResponse> {
    const res = await this.send(route, { body });
    const byHashTree = prepared.byHashTree;
    if (res.status !== 422 || byHashTree === undefined) return res;
    const missing = missingBlobsOf(res);
    if (missing === undefined || missing.length === 0) return res;
    const byBlob = fileByBlob(byHashTree);
    const files = missing.map((sha256) => byBlob.get(sha256));
    if (files.some((file) => file === undefined)) return res;
    const answer = await this.findMissingBlobs({
      blobs: files.map((file) => ({ sha256: file!.sha256, size: file!.size })),
    });
    await this.uploadMissing(byHashTree, answer.missing, read);
    return this.send(route, { body });
  }

  // ── Pipe I/O (Pipelex API extension — `POST /v1/pipe-io`) ─────────

  /**
   * Read a method's three I/O artifacts — `POST /v1/pipe-io`.
   *
   * Resolves the method through the server's static core, selects a pipe, and
   * returns its pipe I/O contracts, input form and output form (the MTHDS standard's
   * artifacts, typed from `mthds/protocol`) beside the resolved `pipe_ref`, the
   * method's own `default_pipe_ref` and the runnability facts. It runs no dry run, so
   * it costs one load and one derivation where `validate` dry-runs every pipe.
   *
   * The method travels as `validate` sends it: `files`, the map posted as given, or
   * `tree`, which the client sends inline or by hash (see `prepareMethodFiles`), the
   * two refused together, as is an empty tree, before anything is sent. A tree sent
   * by hash and refused with a `422` coded `request.blobs_missing` is uploaded and resent
   * once, and a tree refused as too large is prepared again on a fresh handshake and
   * resent once. A `method_ref` or a `method_id` is posted as given.
   *
   * Returns a **200 verdict**: pattern-match `is_valid` before reading the arm. A
   * method that does not load comes back as `is_valid: false` with its `errors`, problem items,
   * never as a throw. Only a no-verdict condition throws an `ApiResponseError`: a malformed
   * selector, a tree the runner refuses and a refused pipe selection are `422`s (a selection
   * refusal is coded by one of `PIPE_SELECTION_CODES`), a registry-form `method_ref` is a `501`,
   * and an artifact that cannot be derived is a `500`.
   *
   * The selector XOR between the tree, `method_ref` and `method_id` is the server's
   * to enforce. A `method_ref` gets the fetch-sized budget; every other request gets
   * the static-route one.
   */
  async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
    const { files, tree, ...rest } = request;
    const route = this.route("POST", "pipe-io", crateRequestTimeoutMs(request));
    let res: RawResponse;
    if (files == null && tree == null) {
      res = await this.send(route, { body: rest });
    } else {
      assertOneMethodSource({ files, tree });
      res = await this.postMethodRequest(route, { files, tree }, (prepared) => ({
        files: prepared,
        ...rest,
      }));
    }
    return this.readResult(route, res, isVerdict);
  }
}

// ── Module helpers ────────────────────────────────────────────────────

/**
 * A route's result read as JSON, as `res.json()` reads it: a number too large for a double reads
 * as `Infinity`, and no depth of nesting is refused. A result holds whatever a run produced, so a
 * successful run, which may have been paid for, is never read as a failure for the numbers or the
 * nesting of its output. The guards of `parseJsonBody` are for the problems an answer carries.
 */
function parseResultBody(text: string): JsonReading {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The base of `POST /execute`'s result: the run's id and its output. */
function isRunResultExecute(value: unknown): boolean {
  return (
    isObject(value) && typeof value.pipeline_run_id === "string" && isObject(value.pipe_output)
  );
}

/**
 * The base of `POST /start`'s result: the run's id, a non-empty string (`runIdOf`), since a start
 * that names no run gives the caller nothing to read the run by.
 */
function isRunResultStart(value: unknown): boolean {
  return runIdOf(value) !== undefined;
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

// The protocol's own request fields and the client-only options — `extra` is for
// extension args only, and merges last into the body, so a protocol field smuggled
// through it would overwrite the named option and bypass the method-source checks,
// and a client-only option would travel to a runner that has no use for it.
const RESERVED_REQUEST_KEYS: ReadonlySet<string> = new Set([
  "pipe_code",
  "files",
  "inputs",
  "output_name",
  "output_multiplicity",
  "dynamic_output_concept_ref",
  "tree",
  "bundleMain",
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
  const overlap = Object.keys(extra).filter((key) => RESERVED_REQUEST_KEYS.has(key));
  if (overlap.length > 0) {
    throw argumentInvalid(
      "extra",
      "reserved_arg",
      `extra carries reserved args [${overlap.sort().join(", ")}] — pass them as named options instead.`,
    );
  }
  return { ...extra };
}

/** Refuse a run request that names nothing to run, before anything is read or sent. */
function assertRunnable(
  options: RunOptions,
  extensions: Record<string, unknown>,
  verb: "execute" | "start",
): void {
  if (!options.pipe_code && !hasMethodSource(options) && Object.keys(extensions).length === 0) {
    throw argumentInvalid(
      "pipe_code",
      "missing",
      `Either pipe_code, the method's tree (files or tree) or a server-specific extension arg (extra) must be provided to ${verb}().`,
    );
  }
}

/**
 * The wire body of `/execute` and `/start`: the protocol's fields, then the
 * extension args. `?? undefined` so JSON.stringify drops absent fields, and the
 * client-only `tree` and `bundleMain` never travel.
 */
function runRequestBody(
  options: RunOptions,
  files: MethodFiles | undefined,
  extensions: Record<string, unknown>,
): RunRequest & Record<string, unknown> {
  return {
    pipe_code: options.pipe_code ?? undefined,
    files,
    inputs: options.inputs ?? undefined,
    output_name: options.output_name ?? undefined,
    output_multiplicity: options.output_multiplicity ?? undefined,
    dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
    ...extensions,
  };
}

/** Read every file of the tree not read yet for this request, and give the bytes by path. */
async function readAll(tree: MethodTreeSource, read: ReadBytes): Promise<ReadBytes> {
  for (const file of tree.files) {
    if (!read.has(file.path)) read.set(file.path, await tree.readFile(file.path));
  }
  return read;
}

/**
 * The refusal of a tree past the inline limit of a runner that keeps no blob store, before
 * anything is sent: `client.argument_invalid` naming the tree.
 */
function inlineLimitError(weight: number, limit: number, measured: string): ProblemError {
  return argumentInvalid(
    "tree",
    "past_inline_limit",
    `The method's tree cannot be sent: this runner keeps no blob store, so a tree travels inline, and ${measured} ${weight} bytes, more than its inline limit max_inline_bytes of ${limit} bytes.`,
  );
}

/** Whether a response is a refusal of the tree as past one of the runner's limits. */
function isMethodTreeTooLarge(res: RawResponse): boolean {
  if (res.status !== 422) return false;
  const reading = parseJsonBody(res.body);
  if (!reading.ok || !isObject(reading.value)) return false;
  const body = reading.value;
  if (body.code === PACKAGE_INVALID_CODE) {
    return isObject(body.params) && typeof body.params.limit === "number";
  }
  return (
    body.code === METHOD_TREE_TOO_LARGE_CODE || body.error_type === METHOD_TREE_TOO_LARGE_ERROR_TYPE
  );
}

/**
 * The blobs a `422` lists as missing: the `params.missing_blobs` of a `request.blobs_missing`
 * problem, each a SHA-256 in lowercase hexadecimal, or `undefined` when the answer is no such
 * problem.
 */
function missingBlobsOf(res: RawResponse): string[] | undefined {
  const problem = readProblemBody(res.body);
  if (problem === undefined || problem.code !== BLOBS_MISSING_CODE) return undefined;
  return problem.params?.missing_blobs;
}

/**
 * What is wrong with one entry of a `/blobs/missing` answer, or `null` when it is a
 * missing blob as the protocol shapes it. The upload URL is never quoted, since it is
 * a signed capability.
 */
function missingBlobFault(entry: unknown): string | null {
  if (!isObject(entry)) return "it is not an object";
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    return "its sha256 is not 64 lowercase hexadecimal digits";
  }
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    return "its size is not a non-negative integer";
  }
  const upload = entry.upload;
  if (!isObject(upload)) return "it has no upload object";
  if (typeof upload.method !== "string" || upload.method.length === 0) {
    return "its upload.method is not a method name";
  }
  if (typeof upload.url !== "string" || !URL.canParse(upload.url)) {
    return "its upload.url is not a URL";
  }
  const headers = upload.headers;
  if (!isObject(headers) || Object.values(headers).some((value) => typeof value !== "string")) {
    return "its upload.headers is not an object of strings";
  }
  return null;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  return value != null && value.length > 0 ? value : undefined;
}

/**
 * The request budget for a crate-route call: the fetch-sized one when the method
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
