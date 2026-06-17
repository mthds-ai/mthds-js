/**
 * Dict-serialized wire models — the SDK's concrete JSON materialization of the
 * protocol's domain shapes. The single home (parity D8) for `DictStuff` /
 * `DictWorkingMemory` / `DictPipeOutput` and the default `RunResultExecute`
 * binding. Mirrors `mthds/runners/api/models.py`.
 *
 * These are the JSON forms the runners deal in: each `Stuff` reduced to
 * `{ concept: <ref>, content }`, working memory as a flat root + aliases, the
 * pipe-output as that working memory + a run id, and `DictRunResultExecute` as
 * the protocol's `RunResultExecute` carrying a `DictPipeOutput`.
 */

import type {
  InvalidValidationReport,
  RunResultExecute,
  ValidationReport,
} from "../../protocol/models.js";

export interface DictStuff {
  concept: string;
  content: unknown;
}

export interface DictWorkingMemory {
  root: Record<string, DictStuff>;
  aliases: Record<string, string>;
}

/**
 * Serialized pipe output — exact mirror of python's `DictPipeOutputAbstract`
 * (`{working_memory, pipeline_run_id}`). NOTE: the inner `pipeline_run_id` is a
 * runtime-internal field produced by the pipelex runtime inside the
 * `pipe_output` payload — it deliberately keeps its name (master plan D1:
 * runtime internals are out of the wire-rename scope, matching mthds-python).
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  pipeline_run_id: string;
}

/**
 * The default `RunResultExecute` binding — the concrete execute result with a
 * Dict-serialized output. `RunResultExecute<DictPipeOutput>` is what both
 * runners (API + pipelex CLI) produce; extension fields (e.g.
 * `main_stuff_name`) ride the protocol's extension-open response.
 */
export type DictRunResultExecute = RunResultExecute<DictPipeOutput>;

// ── Validate surface (Pipelex-API extensions over the protocol) ──────────
//
// `POST /v1/validate` is a diagnostic endpoint: every produced verdict rides a
// 200, discriminated on `is_valid` (the protocol's `ValidationResult` union).
// The Pipelex API narrows both arms: the VALID arm is the canonical
// `PipelexValidationReport` body (mirror of `pipelex/pipeline/validation_report.py`)
// plus a couple of wire-only extras; the INVALID arm is `PipelexInvalidReport`,
// carrying a structured `validation_errors[]` list (`ValidationErrorItem[]`) — see
// below. Non-2xx is reserved for no-verdict conditions (a malformed request, an
// `mthds_sources` length mismatch, auth, a server fault), surfaced as `ApiResponseError`.

/** Per-pipe dry-run verdict in `validated_pipes[]` — mirror of pipelex's `DryRunStatus`. */
export type DryRunStatus = "SUCCESS" | "FAILURE" | "SKIPPED";

/** One entry of `PipelexValidationReport.validated_pipes` — `{pipe_ref, status}`. */
export interface ValidatedPipeEntry {
  /** Namespaced `pipe_ref` (`domain.code`) — never the bare code. */
  pipe_ref: string;
  status: DryRunStatus;
}

/**
 * Pipelex's `POST /v1/validate` 200 body for a VALID bundle — the canonical
 * `PipelexValidationReport` (typed extension over the protocol's `ValidationReport`,
 * carrying its `is_valid: true` discriminant) plus the route's wire-only extras
 * (`message`, the `mthds_contents` echo). Field names follow the MTHDS brand
 * boundary — blueprints/graphs are language artifacts, so no `pipelex_` prefix
 * inside this envelope.
 *
 * `bundle_blueprint`, `pipe_io_contracts`, and `graph_spec` stay opaque transport
 * (`Record<string, unknown>` / `unknown`): their canonical schemas are owned
 * elsewhere (the runtime's blueprint models; `@pipelex/mthds-ui` owns `GraphSpec`),
 * and the extension casts `graph_spec` to the renderer's type. Inherits the
 * extension index signature, so any further server field is preserved.
 */
export interface PipelexValidationReport extends ValidationReport {
  /** The batch's primary blueprint (first declaring `main_pipe`, else first). */
  bundle_blueprint: Record<string, unknown>;
  /** Per-pipe input/output contracts, keyed by namespaced `pipe_ref` (`domain.code`). */
  pipe_io_contracts: Record<string, unknown>;
  /** Best-effort execution graph of the main pipe; `null` with no `main_pipe` or on degrade. */
  graph_spec: unknown;
  /** Per-pipe dry-run sweep outcomes. */
  validated_pipes: ValidatedPipeEntry[];
  /** Qualified refs of pipes still declared as `PipeSignature`. */
  pending_signatures: string[];
  /** `not pending_signatures` — whether the validated library is complete enough to run. */
  is_runnable: boolean;
  /** Route extra: status message. */
  message: string;
  /** Route extra: echo of the submitted `mthds_contents`. */
  mthds_contents?: string[];
}

/**
 * Pipelex's `POST /v1/validate` 200 body for an INVALID bundle — the `is_valid: false`
 * arm of the response union, narrowing the protocol's `InvalidValidationReport` to the
 * closed-vocabulary `ValidationErrorItem[]`. The structural artifacts of the valid arm
 * are absent (they don't exist when load/parse/wiring failed); `validation_errors[]` is
 * non-empty on every invalid verdict (the structured-info invariant — even a parse-level
 * failure carries one source-less `blueprint_validation` residual).
 */
export interface PipelexInvalidReport extends InvalidValidationReport {
  /** Structured per-error diagnostics, built by pipelex's one shared builder. */
  validation_errors: ValidationErrorItem[];
}

/**
 * The Pipelex `POST /v1/validate` 200 response — the discriminated union the
 * `MthdsApiClient.validate` returns, keyed on `is_valid`. Narrows the protocol's
 * `ValidationResult` to Pipelex's typed arms.
 */
export type PipelexValidationResult = PipelexValidationReport | PipelexInvalidReport;

/**
 * Which validation stage produced a `ValidationErrorItem` — mirror of pipelex's
 * closed `ValidationErrorCategory` set. `pipe_factory` and graph-level `dry_run`
 * items carry no `source`; map those by `domain_code` / `pipe_code`. The other
 * categories carry `source` when the runtime can attribute one.
 */
export type ValidationErrorCategory =
  | "blueprint_validation"
  | "pipe_factory"
  | "pipe_validation"
  | "dry_run";

/**
 * One structured bundle-validation error — exact mirror of pipelex's
 * `ValidationErrorItem` (the union across the `ValidateBundleError` error-data
 * models). Carried by `PipelexInvalidReport.validation_errors[]` on the **200**
 * invalid arm of `POST /v1/validate` (NOT a 422 — an invalid bundle is a produced
 * verdict). The same typed item also rides the build routes' 422 problem bodies
 * (`ApiResponseError.validationErrors`).
 *
 * Only `category` and `message` are always present; the rest are populated per
 * `category` and dropped from the wire when unset (`exclude_none` server-side).
 * `source` is the declaring file path (CLI) or the per-content `mthds_sources` name
 * the API threads onto the in-memory load path — the owning file for cross-file
 * diagnostics.
 */
export interface ValidationErrorItem {
  category: ValidationErrorCategory;
  message: string;
  error_type?: string;
  pipe_code?: string;
  concept_code?: string;
  domain_code?: string;
  source?: string;
  field_path?: string;
  field_name?: string;
  variable_names?: string[];
  missing_concept_code?: string;
  declared_concepts?: string[];
}
