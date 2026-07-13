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

import type { RunResultExecute } from "../../protocol/models.js";

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

// ── Build-route validation errors (Pipelex-API layer 2 — `/v1/build/*`) ──
//
// What remains here is the structured error item the BUILD routes' `422`
// problem bodies carry (`ApiResponseError.validationErrors`) — neutrally named,
// so no brand violation. `MthdsApiClient.validate()` returns the protocol's
// neutral `ValidationResult` (its invalid arm exposes only the standard
// `category` + `message`). The Pipelex-API narrowing of the `/v1/validate`
// verdict — the typed structural artifacts (`bundle_blueprint`, `graph_spec`,
// `validated_pipes`, …) and the closed-vocabulary `validation_errors[]` — lives
// in the runtime SDK (`@pipelex/sdk`'s `PipelexValidationResult`), not in the
// standard's client.

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
 * models). In `mthds` it narrows the **200** invalid arm of every `/v1/build/*`
 * route ({@link CrateInvalidReport}), and it also types whatever validation
 * errors ride a problem body (`ApiResponseError.validationErrors`). The same item
 * narrows the 200 invalid `/v1/validate` verdict, but that narrowing
 * (`PipelexInvalidReport`) lives in the runtime SDK (`@pipelex/sdk`) — `mthds`'s
 * own `validate()` returns the protocol's neutral `ValidationResult`, whose
 * invalid arm exposes only the standard `category` + `message`.
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
