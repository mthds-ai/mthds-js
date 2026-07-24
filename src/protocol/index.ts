/**
 * Public barrel for the **pure MTHDS Protocol** surface — the `mthds/protocol`
 * subpath export.
 *
 * This is the single source of truth for the protocol wire types/helpers that
 * downstream packages (e.g. `@pipelex/sdk`) build their clients on. It re-exports
 * only `protocol/` modules — the interface, wire models, request/options surface,
 * abstract domain shapes, and the protocol-base exception. It imports NOTHING
 * from `runners/`, `cli/`, `agent/`, or `config/`; `dependency-cruiser`'s
 * `protocol-stays-pure` rule enforces that purity. The top-level `mthds` barrel
 * (`src/index.ts`) re-exports this barrel so the two cannot drift.
 */

// ── Protocol interface ───────────────────────────────────────────────
export type { MTHDSProtocol } from "./protocol.js";

// ── Protocol-base exception ──────────────────────────────────────────
export { PipelineRequestError } from "./exceptions.js";

// ── Request/options surface ──────────────────────────────────────────
export type {
  RunRequest,
  StartRequest,
  RunOptions,
  StartOptions,
  ExtensionOptions,
} from "./options.js";
// Run-source predicates — invariants of the request shape itself, so every
// client that builds a `RunRequest` enforces them from one definition.
export { assertExclusiveRunSources, hasBundlePayload } from "./options.js";

// ── Method-file (catalog) serialization ──────────────────────────────
// The canonical `[{ name, content }]` form a stored method's source/`python`
// serializes to; one owner so consumers stop re-porting the platform's parser.
export type { MethodFile } from "./method_files.js";
export { serializeMethodFiles, parseMethodFiles } from "./method_files.js";

// ── Wire models ──────────────────────────────────────────────────────
export { MTHDS_PROTOCOL_VERSION, MODEL_CATEGORIES } from "./models.js";
export type {
  RunResultExecute,
  RunResultStart,
  ModelCategory,
  ModelInfo,
  ModelDeck,
  ValidationReport,
  ValidationError,
  InvalidValidationReport,
  ValidationResult,
  VersionInfo,
} from "./models.js";
export type { VariableMultiplicity, PipeOutputAbstract } from "./pipe_output.js";
export type { StuffContentOrData, PipelineInputs } from "./pipeline_inputs.js";

// ── Abstract domain shapes (exact mirror of mthds-python) ─────────────
export { conceptRef } from "./concept.js";
export type { ConceptAbstract } from "./concept.js";
export type { StuffAbstract, StuffContentAbstract } from "./stuff.js";
export type { WorkingMemoryAbstract } from "./working_memory.js";
