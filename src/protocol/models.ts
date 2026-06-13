/**
 * Wire models for the MTHDS Protocol — exact mirror of `mthds/protocol/models.py`
 * (which mirrors `mthds-protocol.openapi.yaml`, the standard's normative artifact).
 *
 *   POST /execute  : -> RunResultExecute (200: pipeline_run_id + pipe_output)
 *   POST /start    : -> RunResultStart   (202: pipeline_run_id only)
 *   POST /validate :              -> ValidationReport
 *   GET  /models   :              -> ModelDeck
 *   GET  /version  :              -> VersionInfo
 *
 * Response models declare the protocol's BASE fields only and are
 * extension-open: an implementation may return more, and those server-specific
 * fields are preserved (via the index signature) — the response side of the
 * same passthrough principle as the request-side `extra`.
 */

/** The MTHDS Protocol version this SDK implements (the MTHDS standard version). */
export const MTHDS_PROTOCOL_VERSION = "0.6.0";

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

/** Model categories accepted by the protocol's `GET /models?type=` filter. */
export type ModelCategory = "llm" | "extract" | "img_gen" | "search";

export const MODEL_CATEGORIES: readonly ModelCategory[] = [
  "llm",
  "extract",
  "img_gen",
  "search",
];

/** One entry of the model deck (`ModelDeck.models[]`) — base fields + extensions. */
export interface ModelInfo {
  name: string;
  type?: ModelCategory | null;
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
 * Verdict of `POST /validate` for a VALID bundle — the 200 status IS the verdict.
 *
 * Failures never reach this shape — they are RFC 7807 problems (HTTP 422,
 * surfaced as `ApiResponseError`). The protocol declares no body fields;
 * implementations may include their own artifacts (parsed structures, graphs,
 * anything else), preserved here as extension fields.
 */
export interface ValidationReport {
  /** Implementation extension fields (e.g. `bundle_blueprint`, `graph_spec`, `pipe_io_contracts`, `pending_signatures`, `is_runnable`). */
  [extension: string]: unknown;
}

/**
 * Protocol + runner versions — `GET /version` (always public).
 *
 * The handshake clients use for feature detection. The protocol defines two
 * base fields (`protocol_version`, optional `runner_version`); implementations
 * may add their own identification (an `implementation` name, an underlying
 * runtime version, anything else) as extensions, preserved via the index
 * signature and read by the api runner's bare-runner detection.
 */
export interface VersionInfo {
  protocol_version: string;
  runner_version?: string | null;
  /** Implementation extension fields (e.g. `implementation`, `runtime_version`). */
  [extension: string]: unknown;
}
