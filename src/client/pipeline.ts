import type { DictPipeOutput } from "./models/pipe_output.js";
import type { VariableMultiplicity } from "./models/pipe_output.js";
import type { PipelineInputs } from "./models/pipeline_inputs.js";

// ── Run state ──────────────────────────────────────────────────────


// ── Requests (wire bodies) ─────────────────────────────────────────

/**
 * Body of the protocol's `POST /execute` — mirrors `RunRequest` in
 * `mthds-protocol.openapi.yaml`. At least one of `pipe_code` /
 * `mthds_contents` is required.
 */
export interface RunRequest {
  /** Code of the pipe to execute (registered, or defined in `mthds_contents`). */
  pipe_code?: string | null;
  /** MTHDS bundle contents to load (always an array, even for one file). */
  mthds_contents?: string[] | null;
  /** Method inputs: map of input name to content (loose here, strict in the runtime). */
  inputs?: PipelineInputs | Record<string, unknown> | null;
  /** Name of the output slot to return as the main output. */
  output_name?: string | null;
  /** Output multiplicity override (`false`/`true` or an exact count). */
  output_multiplicity?: VariableMultiplicity | null;
  /** Override for the dynamic output concept reference. */
  dynamic_output_concept_ref?: string | null;
}

/**
 * Body of the protocol's `POST /start` — the same basic arguments as `RunRequest`.
 *
 * The protocol declares no start-only request fields. Anything an
 * implementation accepts on top (a client-supplied run id, anything else) is
 * an extension arg — the server that defines it is the one that handles it;
 * callers pass it through the generic `extra` option.
 */
export type StartRequest = RunRequest;

/**
 * The generic extension passthrough: server-specific args merged into the
 * request body as top-level properties — the server you call defines and
 * handles them; this SDK only passes them through. Protocol args inside
 * `extra` are rejected client-side.
 */
export interface ExtensionOptions {
  extra?: Record<string, unknown> | null;
}

// ── Responses ──────────────────────────────────────────────────────

/**
 * The protocol's single run response — `POST /execute` 200 (`pipe_output`
 * present), `POST /start` 202 and the optional `/execute` 202 degrade
 * (`pipe_output` absent).
 *
 * Exactly two base fields: the authoritative server-generated
 * `pipeline_run_id` and the method's `pipe_output`. Anything more an
 * implementation returns (a run state, timestamps, output naming, anything
 * else) is an extension field — preserved via the index signature, never
 * named by this SDK.
 */
export interface RunResult {
  pipeline_run_id: string;
  /** The method's full output working memory (serialized stuffs). Absent on `/start`. */
  pipe_output?: DictPipeOutput | null;
  /** Implementation extension fields — defined and documented by the server. */
  [extension: string]: unknown;
}

// ── Method options ─────────────────────────────────────────────────

/**
 * Options for `MTHDSProtocol.execute` — the `RunRequest` fields. (The options
 * surface and the wire body are intentionally the same shape.)
 */
export type RunOptions = RunRequest & ExtensionOptions;
