/**
 * Wire models for the MTHDS Protocol — exact mirror of `mthds/protocol/models.py`
 * (which mirrors `mthds-protocol.openapi.yaml`, the standard's normative artifact).
 *
 *   POST /execute  : -> RunResultExecute (200: pipeline_run_id + pipe_output)
 *   POST /start    : -> RunResultStart   (202: pipeline_run_id only)
 *   POST /validate :              -> ValidationResult (200: discriminated on `is_valid`)
 *   GET  /models   :              -> ModelDeck
 *   GET  /version  :              -> VersionInfo
 *   POST /blobs/missing : MissingBlobsRequest -> MissingBlobsResult (optional route)
 *   PUT  /blobs/{sha256}: a blob's bytes -> 204 (optional route)
 *
 * Response models declare the protocol's BASE fields only and are
 * extension-open: an implementation may return more, and those server-specific
 * fields are preserved (via the index signature) — the response side of the
 * same passthrough principle as the request-side `extra`.
 */

import type { ProblemItem } from "../problems/types.js";

/**
 * The MTHDS Protocol version this SDK implements — the HTTP runner contract: its
 * routes and their request and response shapes. Cut by
 * `mthds/docs/spec/versioning.md` § "The Protocol Version"; this is the single
 * declaration of it in this package, so following a cut is one edit.
 *
 * It moves on its own cadence and is **not** derived from the MTHDS standard
 * version (`MTHDS_STANDARD_VERSION` in `package/manifest/schema.ts`): a release of
 * the standard that leaves the protocol alone leaves this number where it is. It
 * is the `info.version` of `mthds-protocol.openapi.yaml` and what a runner reports
 * as `protocol_version` from `GET /version`.
 */
export const MTHDS_PROTOCOL_VERSION = "2.0.1";

// ── Run responses (`POST /execute` 200, `POST /start` 202) ───────────

/**
 * `POST /execute` 200 — the completed run.
 *
 * Two base fields: the authoritative server-generated `pipeline_run_id` and
 * the method's `pipe_output` (always present — a completed run has output).
 * Generic in the output type so `protocol/` never names a runner-side concrete:
 * the default `DictPipeOutput` binding (`DictRunResultExecute`) lives in
 * `runners/api/models.ts`. Extension-open: anything more an implementation
 * returns (a run state, timestamps, output naming) rides the index signature,
 * never named by this SDK.
 */
export interface RunResultExecute<TPipeOutput = unknown> {
  pipeline_run_id: string;
  pipe_output: TPipeOutput;
  /** Implementation extension fields — defined and documented by the server. */
  [extension: string]: unknown;
}

/**
 * `POST /start` 202 (and the optional `/execute` 202 degrade) — the started
 * run's authoritative `pipeline_run_id`, nothing else.
 *
 * A started run has no output yet; how it is delivered later (polling,
 * callbacks, anything else) is implementation-defined and outside the
 * protocol. Extension-open: an implementation may add its own fields (a
 * workflow id, a created-at timestamp), preserved via the index signature.
 */
export interface RunResultStart {
  pipeline_run_id: string;
  /** Implementation extension fields — defined and documented by the server. */
  [extension: string]: unknown;
}

// ── Discovery + validation (`POST /validate`, `GET /models`, `GET /version`) ──

/**
 * The protocol's model categories, in the order its "Discovery" section lists
 * them. A category is a settings family of the language — the inline settings a
 * model serves, and so the pipes that can name it: `llm` (`LLMSetting`:
 * `PipeLLM`, `PipeStructure`), `extract` (`ExtractSetting`: `PipeExtract`),
 * `img_gen` (`ImgGenSetting`: `PipeImgGen`), `search` (`SearchSetting`:
 * `PipeSearch`) and `judgment` (`JudgmentSetting`: `PipeJudge`).
 *
 * A `const` tuple so that the {@link ModelCategory} union is derived from it and
 * the runtime list and the type cannot drift. It is the closed set a runner may
 * emit in a deck entry's `type` and accept on the `GET /models?type=` filter;
 * what a client reads is wider (see {@link ModelInfo}).
 */
export const MODEL_CATEGORIES = ["llm", "extract", "img_gen", "search", "judgment"] as const;

/** A model category the protocol defines — the closed set of {@link MODEL_CATEGORIES}. */
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

/** One entry of the model deck (`ModelDeck.models[]`) — base fields + extensions. */
export interface ModelInfo {
  name: string;
  /**
   * The entry's model category. Open on purpose: "A client reading a model list
   * MUST NOT fail it because an entry carries a category it does not recognize;
   * it keeps that entry with its raw value or leaves it out." This SDK keeps it,
   * so a runner of a later protocol minor that reports a category this version
   * has never heard of reaches the caller as the raw string. `string & {}` keeps
   * the editor's completion on the known values; a consumer that indexes a table
   * by this field has to say what an unknown category does.
   */
  type?: ModelCategory | (string & {}) | null;
}

/**
 * The model deck a runner can route to — `GET /models`.
 *
 * The protocol's base is the `models` list; implementations may add their own
 * routing metadata (aliases, fallback chains, anything else) as extensions,
 * preserved via the index signature.
 */
export interface ModelDeck {
  models: ModelInfo[];
  /** Implementation extension fields (e.g. `aliases`, `waterfalls`). */
  [extension: string]: unknown;
}

/**
 * Verdict of `POST /validate` for a VALID bundle — the `is_valid: true` arm of
 * the 200-diagnostic response union ({@link ValidationResult}).
 *
 * `/validate` is a diagnostic endpoint: every verdict it can produce — valid,
 * invalid, or valid-but-not-runnable — rides a **200**, discriminated in the
 * body on `is_valid`. Non-2xx is reserved for the cases where *no verdict could
 * be produced* (a malformed request body, a `files` map that is not a tree,
 * auth, a server fault) — those surface as `ApiResponseError`. The protocol
 * declares no further body fields; implementations may include their own
 * artifacts (parsed structures, graphs, anything else), preserved here as
 * extension fields.
 *
 * Two of those extensions the standard itself defines and recommends, under
 * fixed field names: `pipe_io_contracts` — the per-pipe input/output contracts,
 * typed as `PipeIOContracts` in `./pipe_io_contracts.ts` — and `input_form` —
 * the per-pipe ordered input-form descriptor, typed as `InputForm` in
 * `./input_form.ts`. They are *recommended extension fields*, not base fields
 * (the protocol's base did not change when the standard adopted them, and how
 * a caller asks an implementation for the descriptor stays
 * implementation-defined), so they ride the index signature here and a
 * consumer narrows them by import: `report.pipe_io_contracts as PipeIOContracts`.
 * Unlike this report, both artifacts are closed shapes.
 */
export interface ValidationReport {
  /** Discriminant of the valid arm of the 200 response union. */
  is_valid: true;
  /**
   * Whether the validated library is complete enough to run: `false` when pipe signatures remain
   * unimplemented, a runnability fact and not an error. The protocol requires it of a runner; the
   * local pipelex runner's minimal valid arm leaves it out, so a reader does not rely on it.
   */
  is_runnable?: boolean;
  /** Refs of pipes still declared as unimplemented signatures, required as `is_runnable` is. */
  pending_signatures?: string[];
  /** Advisory findings, one problem item each, which never make the bundle invalid. */
  warnings?: ProblemItem[];
  /**
   * Implementation extension fields (e.g. `bundle_blueprint`, `graph_spec`,
   * `validated_pipes`) — and the standard's recommended ones, `pipe_io_contracts`
   * (`PipeIOContracts`), `input_form` (`InputForm`) and `output_form`.
   */
  [extension: string]: unknown;
}

/**
 * Verdict of `POST /validate` for an INVALID bundle — the `is_valid: false` arm
 * of the 200 response union.
 *
 * An invalid bundle is the *successful product* of a diagnostic call, not a
 * transport failure (the request was well-formed; the bundle was not), so it
 * rides a **200**. The structural artifacts of a valid report do not exist when
 * load/parse/wiring failed, so this arm carries only the faults, the advisory
 * warnings and the runnability facts. Each fault is a problem item with its own
 * `code`, `detail`, `params` and `location`, and may carry `suggestions` and a
 * `suggested_fix`; an item carries no domain, which a reader reads from its code
 * (`itemDomain`).
 */
export interface InvalidValidationReport {
  /** Discriminant of the invalid arm. */
  is_valid: false;
  /** One problem item per fault — non-empty on every invalid verdict. */
  errors: ProblemItem[];
  /** Advisory findings in the same item schema, which do not make the verdict invalid. */
  warnings?: ProblemItem[];
  /** Outstanding signatures (best-effort; empty when no library could be assembled). */
  pending_signatures?: string[];
  /** An invalid bundle is never runnable. */
  is_runnable: false;
  /** Human-readable summary of the verdict. */
  message?: string;
  /** Implementation extension fields, such as Pipelex's `rendered_markdown`. */
  [extension: string]: unknown;
}

/**
 * The discriminated 200 response of `POST /validate`, keyed on the mandatory
 * `is_valid` field. A consumer pattern-matches that one field to learn the
 * verdict — never inspecting a status code or catching an exception body. Only a
 * *no-verdict* condition (non-2xx) throws.
 */
export type ValidationResult = ValidationReport | InvalidValidationReport;

/**
 * Protocol + runner versions — `GET /version` (always public).
 *
 * The handshake clients use for feature detection. The protocol defines
 * `protocol_version`, an optional `runner_version` and an optional `blob_store`
 * flag; implementations may add their own identification (an `implementation`
 * name, an underlying runtime version, anything else) as extensions, preserved
 * via the index signature and read by the api runner's bare-runner detection.
 */
export interface VersionInfo {
  protocol_version: string;
  runner_version?: string | null;
  /**
   * `true` when the runner keeps a blob store: it serves `POST /blobs/missing` and
   * resolves hash entries in a `files` map. False or absent when it does not, and
   * then it answers any hash entry with a `422` listing `missing_blobs`.
   */
  blob_store?: boolean | null;
  /**
   * Implementation package version — the field clients gate capabilities on
   * (e.g. the VS Code extension's `MIN_API_IMPLEMENTATION_VERSION`). An
   * extension field (the protocol declares only `protocol_version` /
   * `runner_version`), typed here as the one well-known extension so consumers
   * gate on it without reaching through the untyped index signature. Absent on
   * a runner that does not advertise it.
   */
  implementation_version?: string;
  /** Further implementation extension fields (e.g. `implementation`, `runtime_version`). */
  [extension: string]: unknown;
}

/** A blob, named by its SHA-256 in lowercase hexadecimal and its length in bytes. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/**
 * Body of the optional `POST /blobs/missing`: the blobs a sender is about to send
 * by hash, each hash listed once, and optionally the digest of the tree they make
 * up, which lets a runner that records the trees it holds answer an unchanged
 * tree in one lookup.
 */
export interface MissingBlobsRequest {
  blobs: BlobRef[];
  digest?: string;
}

/**
 * Where to upload one blob: the sender sends the blob's bytes as the whole body of
 * a request with this method to this URL, carrying exactly these headers. The
 * target is the runner's choice, its own `PUT /blobs/{sha256}` or any address that
 * stores the bytes where the runner reads its blobs, such as a presigned
 * object-store URL. Extension-open.
 */
export interface UploadTarget {
  method: string;
  url: string;
  headers: Record<string, string>;
  [extension: string]: unknown;
}

/** A blob the runner lacks, with where to upload it. Extension-open. */
export interface MissingBlob {
  sha256: string;
  size: number;
  upload: UploadTarget;
  [extension: string]: unknown;
}

/**
 * The `200` answer of `POST /blobs/missing`: every blob of the request the runner
 * does not hold. An empty list means there is nothing to upload. Extension-open.
 */
export interface MissingBlobsResult {
  missing: MissingBlob[];
  [extension: string]: unknown;
}
