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
import type { DictRunResultExecute, ValidationErrorItem } from "./models.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  BlobUploadError,
  MalformedBlobsAnswerError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RunStillRunningError,
} from "./exceptions.js";
import type { ProblemDetails, UserAction } from "./exceptions.js";
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
 * How a runner refuses a tree past one of its limits, on a run or a validation. The standard
 * asks for "a problem naming the limit" and pins no member to recognize it by, so the client
 * reads the two runners that send one: the hosted platform's problem `code` (with its `limit:
 * {name, value, reached}`), and pipelex-api's `error_type`, which the platform also relays when
 * the runner behind it refuses the tree.
 */
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
 *   I/O artifacts. It lives on this class and not on `Runner`: the local pipelex
 *   runner shells out and has no use for it.
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
   * The ONE place request headers are built — both `requestRaw` and
   * `requestJson` go through it, so no request path can miss the
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
    const hasBody = options.body !== undefined;
    const headers = this.buildHeaders(hasBody);

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
   * Issue a request and parse the JSON body, throwing an `ApiResponseError`
   * on a non-2xx response, so a refusal carries its problem members here as on
   * the protocol routes. Used by `health`. Unlike
   * `requestRaw`, it sets no timeout and does not wrap a network failure as
   * `ApiUnreachableError`.
   */
  private async requestJson<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const headers = this.buildHeaders(body !== undefined);
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.apiResponseError(`${method} ${url}`, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: text,
      });
    }
    return res.json() as Promise<T>;
  }

  private throwApiResponseError(method: "GET" | "POST", endpoint: string, res: RawResponse): never {
    throw this.apiResponseError(`${method} /${API_PREFIX}/${endpoint}`, res);
  }

  /** Build the `ApiResponseError` for a non-2xx response; `request` names it in the message (`POST /v1/execute`). */
  private apiResponseError(request: string, res: RawResponse): ApiResponseError {
    const { errorType, serverMessage, validationErrors, problem } = parseErrorBody(res.body);
    // The body's `request_id` wins; the header is the fallback for a response
    // whose body carries none (a gateway error page, a non-problem body).
    const requestId = problem.requestId ?? nonEmptyHeader(res.headers, "x-request-id");
    return new ApiResponseError(
      `API ${request} failed (${res.status}): ${serverMessage ?? (res.body || res.statusText)}`,
      this.baseUrl,
      res.status,
      res.statusText,
      res.body,
      errorType,
      serverMessage,
      validationErrors,
      { problem: { ...problem, requestId } },
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
        "(`@pipelex/sdk`), or use start().",
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
   * The method travels as `files`, the map sent as given, or as `tree`, which the
   * client sends inline or by hash (see `prepareMethodFiles`). Sent by hash, a
   * `422` naming `missing_blobs` is answered by uploading them and resending once.
   *
   * Behind the hosted gateway, synchronous requests terminate at ~30s; a run that
   * exceeds that surfaces as `PipelineExecuteTimeoutError`. Throws
   * `RunStillRunningError` on the protocol's optional 202 degrade.
   */
  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const extensions = buildExtensions(options.extra);
    assertOneMethodSource(options);
    assertRunnable(options, extensions, "execute");

    // Measured from the request itself, not from the uploads before it, which the
    // gateway's clock does not see.
    let sentAt: number | undefined;
    try {
      const res = await this.postMethodRequest(
        "execute",
        options,
        (files) => runRequestBody(options, files, extensions),
        {
          onSend: () => {
            sentAt = Date.now();
          },
        },
      );
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
      const elapsedMs = sentAt === undefined ? 0 : Date.now() - sentAt;
      if (isGatewayTimeout(err, elapsedMs)) {
        throw new PipelineExecuteTimeoutError(elapsedMs, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Start a method asynchronously — `POST /v1/start` (202, no output yet).
   *
   * The method travels as `execute` sends it. Server-specific extension args ride
   * `options.extra` and merge into the request body — the server you call defines
   * and handles them (including a client-supplied run id where a server supports
   * one). The returned `pipeline_run_id` is always authoritative. How completion is
   * later delivered (durable polling, callbacks) is implementation-defined and
   * outside this client — the durable run-lifecycle lives in `@pipelex/sdk`.
   */
  async start(options: StartOptions): Promise<RunResultStart> {
    const extensions = buildExtensions(options.extra);
    assertOneMethodSource(options);
    assertRunnable(options, extensions, "start");

    const res = await this.postMethodRequest(
      "start",
      options,
      (files) => runRequestBody(options, files, extensions),
      { timeoutMs: POLL_REQUEST_TIMEOUT_MS },
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "start", res);
    }
    return JSON.parse(res.body) as RunResultStart;
  }

  /**
   * Parse, validate, and dry-run a method — `POST /v1/validate`.
   *
   * The method travels as its whole tree: `{ files }`, the map sent as given, or
   * `{ tree }`, which the client sends inline or by hash as it does for a run. The
   * runner judges every bundle and every file a bundle names, and attributes each
   * diagnostic to its file by tree path (`validation_errors[].source`).
   *
   * `/validate` is a diagnostic endpoint: every produced verdict rides a **200**,
   * discriminated on `is_valid`. This returns the protocol's neutral
   * `ValidationResult` union verbatim — `is_valid: true` ⇒ a `ValidationReport`,
   * `is_valid: false` ⇒ an `InvalidValidationReport` (`validation_errors[]`). The
   * Pipelex-API narrowing of both arms (the typed structural artifacts, the
   * closed-vocabulary `validation_errors[]`) lives in the runtime SDK
   * (`@pipelex/sdk`'s `PipelexValidationResult`), not in the standard's client.
   * An invalid method is NOT thrown — the caller pattern-matches `is_valid`. Only a
   * *no-verdict* condition (a malformed request, a tree the runner refuses, auth, a
   * server fault) is non-2xx and surfaces as `ApiResponseError`.
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
      throw new PipelineRequestError("validate() needs the method's tree, as files or tree.");
    }
    const res = await this.postMethodRequest(
      "validate",
      source,
      (files) => ({
        files,
        allow_signatures: allowSignatures,
        render: withValidateMarkdownRender(render),
      }),
      {},
    );
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "validate", res);
    }
    return JSON.parse(res.body) as ValidationResult;
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
   * names. `execute`, `start` and `validate` call it for a `tree`; a caller building
   * its own request calls it directly.
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
   * left out, and an empty `missing` means there is nothing to upload.
   */
  async findMissingBlobs(request: MissingBlobsRequest): Promise<MissingBlobsResult> {
    const res = await this.requestRaw("POST", this.url("blobs/missing"), {
      body: request,
      timeoutMs: POLL_REQUEST_TIMEOUT_MS,
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "blobs/missing", res);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new MalformedBlobsAnswerError(
        "POST /v1/blobs/missing answered a body that is not JSON.",
      );
    }
    const missing = isRecord(parsed) ? parsed.missing : undefined;
    if (!Array.isArray(missing)) {
      throw new MalformedBlobsAnswerError(
        "POST /v1/blobs/missing answered without a `missing` list, which the protocol requires.",
      );
    }
    missing.forEach((entry: unknown, index) => {
      const fault = missingBlobFault(entry);
      if (fault !== null) {
        const sha256 = isRecord(entry) && typeof entry.sha256 === "string" ? entry.sha256 : "";
        const wellFormed = SHA256_HEX.test(sha256) ? sha256 : undefined;
        const named = wellFormed === undefined ? "" : ` (blob ${wellFormed})`;
        throw new MalformedBlobsAnswerError(
          `POST /v1/blobs/missing answered a malformed entry at missing[${index}]${named}: ${fault}.`,
          index,
          wellFormed,
        );
      }
    });
    return parsed as MissingBlobsResult;
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
    const timer = setTimeout(
      () => controller.abort(new DOMException("Upload timed out.", "TimeoutError")),
      BLOB_UPLOAD_TIMEOUT_MS,
    );
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
          : (extractNetworkErrorCode(err) ?? "network error");
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
   * hash, a `files` map as given), post it, and answer a `422` naming `missing_blobs`
   * (see `postWithBlobRetry`). When a run or a validation refuses a tree the client
   * prepared as past one of the runner's limits (`isMethodTreeTooLarge`), the limits the
   * handshake announced may be stale, so the client asks the handshake again, prepares
   * the tree as the fresh limits say and sends it once more.
   */
  private async postMethodRequest(
    endpoint: string,
    method: RunOptions,
    body: (files: MethodFiles | undefined) => unknown,
    options: { timeoutMs?: number; onSend?: () => void },
  ): Promise<RawResponse> {
    const read: ReadBytes = new Map();
    const send = async (): Promise<RawResponse> => {
      const prepared = await this.prepareRequestFiles(method, read);
      return this.postWithBlobRetry(endpoint, body(prepared.files), prepared, read, options);
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
   * runner answers a `422` naming `missing_blobs` that the tree holds, such as a
   * blob dropped since the check, the client asks where to upload them, uploads
   * them and sends the same request once more. `onSend` is told each time the
   * request itself goes out, so `execute` measures the gateway's clock from it.
   */
  private async postWithBlobRetry(
    endpoint: string,
    body: unknown,
    prepared: PreparedFiles,
    read: ReadBytes,
    options: { timeoutMs?: number; onSend?: () => void },
  ): Promise<RawResponse> {
    const send = (): Promise<RawResponse> => {
      options.onSend?.();
      return this.requestRaw("POST", this.url(endpoint), { body, timeoutMs: options.timeoutMs });
    };
    const res = await send();
    const byHashTree = prepared.byHashTree;
    if (res.status !== 422 || byHashTree === undefined) return res;
    const missing = parseErrorBody(res.body).problem.missingBlobs;
    if (missing === undefined || missing.length === 0) return res;
    const byBlob = fileByBlob(byHashTree);
    const files = missing.map((sha256) => byBlob.get(sha256));
    if (files.some((file) => file === undefined)) return res;
    const answer = await this.findMissingBlobs({
      blobs: files.map((file) => ({ sha256: file!.sha256, size: file!.size })),
    });
    await this.uploadMissing(byHashTree, answer.missing, read);
    return send();
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
   * closure that does not load comes back as `is_valid: false` with
   * `validation_errors[]`, never as a throw. Only a no-verdict condition throws an
   * `ApiResponseError`: a malformed selector, an over-limit file and a refused pipe
   * selection are `422`s (a selection refusal is typed by one of
   * `PIPE_SELECTION_ERROR_TYPES`), a registry-form `method_ref` is a `501`, and an
   * artifact that cannot be derived is a `500`. An unreachable server is an
   * `ApiUnreachableError`.
   *
   * The request is posted as given, `method_id` included, and the selector XOR is the
   * server's to enforce. A `method_ref` gets the fetch-sized budget; every other
   * request gets the static-route one.
   */
  async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
    const res = await this.requestRaw("POST", this.url("pipe-io"), {
      body: request,
      timeoutMs: crateRequestTimeoutMs(request),
    });
    if (res.status < 200 || res.status >= 300) {
      this.throwApiResponseError("POST", "pipe-io", res);
    }
    return JSON.parse(res.body) as PipeIOResponse;
  }
}

// ── Module helpers ────────────────────────────────────────────────────

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
    throw new PipelineRequestError(
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
    throw new PipelineRequestError(
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

/** The refusal of a tree past the inline limit of a runner that keeps no blob store. */
function inlineLimitError(weight: number, limit: number, measured: string): PipelineRequestError {
  return new PipelineRequestError(
    `The method's tree cannot be sent: this runner keeps no blob store, so a tree travels inline, and ${measured} ${weight} bytes, more than its inline limit max_inline_bytes of ${limit} bytes.`,
  );
}

/** Whether a response is a refusal of the tree as past one of the runner's limits. */
function isMethodTreeTooLarge(res: RawResponse): boolean {
  if (res.status !== 422) return false;
  try {
    const parsed: unknown = JSON.parse(res.body);
    return (
      isRecord(parsed) &&
      (parsed.code === METHOD_TREE_TOO_LARGE_CODE ||
        parsed.error_type === METHOD_TREE_TOO_LARGE_ERROR_TYPE)
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * What is wrong with one entry of a `/blobs/missing` answer, or `null` when it is a
 * missing blob as the protocol shapes it. The upload URL is never quoted, since it is
 * a signed capability.
 */
function missingBlobFault(entry: unknown): string | null {
  if (!isRecord(entry)) return "it is not an object";
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    return "its sha256 is not 64 lowercase hexadecimal digits";
  }
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    return "its size is not a non-negative integer";
  }
  const upload = entry.upload;
  if (!isRecord(upload)) return "it has no upload object";
  if (typeof upload.method !== "string" || upload.method.length === 0) {
    return "its upload.method is not a method name";
  }
  if (typeof upload.url !== "string" || !URL.canParse(upload.url)) {
    return "its upload.url is not a URL";
  }
  const headers = upload.headers;
  if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== "string")) {
    return "its upload.headers is not an object of strings";
  }
  return null;
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
 *
 * The problem document's other members are read too — the RFC 9457 `type`,
 * `title` and `instance`, the protocol's `missing_blobs`, and the extension
 * members `request_id`, `error_domain`, `retryable` and `user_action` — each
 * kept only when it has
 * the type the problem document gives it, so a malformed member reads as
 * absent rather than as a wrong value. Members a runner adds beyond these stay
 * in the raw body (`ApiResponseError.responseBody`).
 */
function parseErrorBody(body: string): {
  errorType: string | undefined;
  serverMessage: string | undefined;
  validationErrors: ValidationErrorItem[] | undefined;
  problem: ProblemDetails;
} {
  const empty = {
    errorType: undefined,
    serverMessage: undefined,
    validationErrors: undefined,
    problem: {},
  };
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
  const problem: ProblemDetails = {
    type: nonEmptyStringMember(root.type),
    title: nonEmptyStringMember(root.title),
    instance: nonEmptyStringMember(root.instance),
    requestId: nonEmptyStringMember(root.request_id),
    errorDomain: nonEmptyStringMember(root.error_domain),
    retryable: typeof root.retryable === "boolean" ? root.retryable : undefined,
    userAction: parseUserAction(root.user_action),
    missingBlobs: parseMissingBlobs(root.missing_blobs),
  };
  return { errorType, serverMessage, validationErrors, problem };
}

/** A `missing_blobs` member is kept as its lowercase hexadecimal hashes, or read as absent. */
function parseMissingBlobs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hashes = value.filter(
    (item): item is string => typeof item === "string" && SHA256_HEX.test(item),
  );
  return hashes.length > 0 ? hashes : undefined;
}

function nonEmptyStringMember(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A `user_action` member is kept only whole: an object with a string `kind` and a non-empty `detail`. */
function parseUserAction(value: unknown): UserAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, detail } = value as Record<string, unknown>;
  if (typeof kind !== "string" || typeof detail !== "string" || detail.length === 0) {
    return undefined;
  }
  return { kind, detail };
}

function nonEmptyHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value ? value : undefined;
}
