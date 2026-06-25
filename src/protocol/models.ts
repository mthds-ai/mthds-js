/**
 * Wire models for the MTHDS Protocol — exact mirror of `mthds/protocol/models.py`
 * (which mirrors `mthds-protocol.openapi.yaml`, the standard's normative artifact).
 *
 *   POST /execute  : -> RunResultExecute (200: pipeline_run_id + pipe_output)
 *   POST /start    : -> RunResultStart   (202: pipeline_run_id only)
 *   POST /validate :              -> ValidationResult (200: discriminated on `is_valid`)
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

export const MODEL_CATEGORIES: readonly ModelCategory[] = ["llm", "extract", "img_gen", "search"];

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
 * Verdict of `POST /validate` for a VALID bundle — the `is_valid: true` arm of
 * the 200-diagnostic response union ({@link ValidationResult}).
 *
 * `/validate` is a diagnostic endpoint: every verdict it can produce — valid,
 * invalid, or valid-but-not-runnable — rides a **200**, discriminated in the
 * body on `is_valid`. Non-2xx is reserved for the cases where *no verdict could
 * be produced* (a malformed request body, an `mthds_sources` length mismatch,
 * auth, a server fault) — those surface as `ApiResponseError`. The protocol
 * declares no further body fields; implementations may include their own
 * artifacts (parsed structures, graphs, anything else), preserved here as
 * extension fields.
 */
export interface ValidationReport {
  /** Discriminant of the valid arm of the 200 response union. */
  is_valid: true;
  /** Implementation extension fields (e.g. `bundle_blueprint`, `graph_spec`, `pipe_io_contracts`, `validated_pipes`, `pending_signatures`, `is_runnable`). */
  [extension: string]: unknown;
}

/**
 * One structured diagnostic on an invalid verdict. The protocol fixes only the
 * neutral `category` + `message`; an implementation narrows `category` to its own
 * closed vocabulary and adds locators (see the Pipelex `ValidationErrorItem`,
 * which extends this with `source`, `pipe_code`, `field_name`, and friends).
 */
export interface ValidationError {
  category: string;
  message: string;
}

/**
 * Verdict of `POST /validate` for an INVALID bundle — the `is_valid: false` arm
 * of the 200 response union.
 *
 * An invalid bundle is the *successful product* of a diagnostic call, not a
 * transport failure (the request was well-formed; the bundle was not), so it
 * rides a **200**. The structural artifacts of a valid report do not exist when
 * load/parse/wiring failed, so this arm carries only the per-error diagnostics
 * plus the runnability facts.
 */
export interface InvalidValidationReport {
  /** Discriminant of the invalid arm. */
  is_valid: false;
  /** Per-error diagnostics — non-empty on every invalid verdict (even a parse-level failure yields one residual item). */
  validation_errors: ValidationError[];
  /** Outstanding signatures (best-effort; empty when no library could be assembled). */
  pending_signatures: string[];
  /** An invalid bundle is never runnable. */
  is_runnable: false;
  /** Human-readable summary of the verdict. */
  message: string;
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
 * The handshake clients use for feature detection. The protocol defines two
 * base fields (`protocol_version`, optional `runner_version`); implementations
 * may add their own identification (an `implementation` name, an underlying
 * runtime version, anything else) as extensions, preserved via the index
 * signature and read by the api runner's bare-runner detection.
 */
export interface VersionInfo {
  protocol_version: string;
  runner_version?: string | null;
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
