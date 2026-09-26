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
 * models). In `mthds` it narrows the **200** invalid arm of the per-pipe `/v1/build/*`
 * projections — `build/inputs`, `build/output`, `build/runner` ({@link
 * CrateInvalidReport}); the spec-to-TOML routes `build/concept` and `build/pipe-spec`
 * have no `is_valid` arm at all and return their own shapes. It also types whatever
 * validation errors ride a problem body (`ApiResponseError.validationErrors`). The same item
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
 *
 * `suggested_fix` is the next step of a refusal: when the runner can derive one
 * deterministic correction for the error, it rides the item as structured patch
 * operations plus a human-readable `description`. An item with no fix has no key.
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
  /** The pipe a reference names that the bundle does not declare. */
  missing_pipe_code?: string;
  declared_concepts?: string[];
  /**
   * On an `unknown_model` item: the model reference exactly as the author wrote it
   * (`gpt-5.1`, `@best-sonet`, `$writting-factual`).
   */
  model_reference?: string;
  /** On an `unknown_model` item: the kind of model the field takes (`llm`, `img_gen`, …). */
  model_type?: string;
  /**
   * On an `unknown_model` item: the close matches of the same kind, each spelled as a
   * reference the field accepts.
   */
  suggestions?: string[];
  /** The runner's deterministic correction for this error, when it has one. */
  suggested_fix?: SuggestedFix;
}

// ── Suggested fixes (the next step a validation item carries) ──
//
// Mirror of pipelex's `SuggestedFix` wire model. The ops are semantic patches over
// the `.mthds` document, addressed by TOML table path, not a text diff — so an
// applier keeps the author's formatting. Every name here is brand-neutral: a fix
// is a language-level concept.

/** Whether a {@link SuggestedFix} is safe to apply without asking, or needs explicit opt-in. */
export type FixSafety = "safe" | "unsafe";

/** The semantic patch operations a {@link SuggestedFix} is composed of. */
export type FixOpKind =
  | "set_key"
  | "ensure_table"
  | "delete_key"
  | "delete_table"
  | "rename_table_key"
  | "move_key"
  | "remap_value";

/**
 * What a `set_key` op writes: a TOML scalar, or a flat mapping of scalars for a fix
 * that creates a whole table at once (written as an inline table).
 */
export type FixValue = string | number | boolean | Record<string, string | number | boolean>;

/**
 * What every fix op carries: the table it acts in. `table_path` addresses the
 * containing table (e.g. `["pipe", "my_seq"]`), aligned with the `field_path`
 * conventions of {@link ValidationErrorItem}, and is empty for the document root.
 * The segment `"*"` stands for every entry of an open mapping; only `remap_value`
 * accepts it as a `key`.
 */
interface FixOpBase {
  table_path: string[];
}

/** Write `key = value` in the addressed table, whatever it currently holds. */
export interface SetKeyOp extends FixOpBase {
  kind: "set_key";
  key: string;
  value: FixValue;
}

/** Create the addressed table when it is absent. Here `table_path` is the table itself, never empty. */
export interface EnsureTableOp extends FixOpBase {
  kind: "ensure_table";
}

/** Remove `key` from the addressed table. */
export interface DeleteKeyOp extends FixOpBase {
  kind: "delete_key";
  key: string;
}

/** Remove the addressed table. Here `table_path` is the table itself, never empty. */
export interface DeleteTableOp extends FixOpBase {
  kind: "delete_table";
}

/** Rename `key` to `new_key` in place within the addressed table. */
export interface RenameTableKeyOp extends FixOpBase {
  kind: "rename_table_key";
  key: string;
  new_key: string;
}

/** Move `key` out of the addressed table into `new_table_path`, under `new_key`. */
export interface MoveKeyOp extends FixOpBase {
  kind: "move_key";
  key: string;
  new_table_path: string[];
  new_key: string;
}

/**
 * Rewrite `key`'s value through `mapping`, leaving a value the mapping does not name
 * untouched. The unknown-model fix is one: it maps the reference as written to its one
 * close match, so it changes nothing once the author has edited the field.
 */
export interface RemapValueOp extends FixOpBase {
  kind: "remap_value";
  key: string;
  mapping: Record<string, string>;
}

/** One patch operation of a {@link SuggestedFix}, discriminated on `kind`. */
export type FixOp =
  | SetKeyOp
  | EnsureTableOp
  | DeleteKeyOp
  | DeleteTableOp
  | RenameTableKeyOp
  | MoveKeyOp
  | RemapValueOp;

/** A deterministic fix for one validation error, ready for a formatting-preserving applier. */
export interface SuggestedFix {
  /** The kebab-case rule id, e.g. `"rename-model"` or `"match-sequence-output"`. */
  fix_code: string;
  /** What the fix does, in a sentence a person or an agent can act on. */
  description: string;
  safety: FixSafety;
  /** The file the ops target, when known (multi-file bundles). Apply the ops to that file only. */
  source?: string;
  ops: FixOp[];
}
