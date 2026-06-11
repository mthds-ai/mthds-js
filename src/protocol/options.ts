/**
 * The MTHDS Protocol's request-argument surface — the named arguments of
 * `execute` / `start`.
 *
 * The protocol has no request *model*: a runner takes the request's basic
 * arguments as named parameters and serializes the wire body directly, merging
 * any server-specific extension args (`extra`) as top-level properties. These
 * option/request shapes are the TS expression of that argument surface.
 */

import type { VariableMultiplicity } from "./pipe_output.js";
import type { PipelineInputs } from "./pipeline_inputs.js";

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

/**
 * Options for `MTHDSProtocol.execute` — the `RunRequest` fields plus the
 * generic `extra` extension passthrough. (The options surface and the wire
 * body are intentionally the same shape.)
 */
export type RunOptions = RunRequest & ExtensionOptions;

/**
 * Options for `MTHDSProtocol.start` — the `StartRequest` wire fields (the
 * protocol's basic execution arguments) plus the generic `extra` extension
 * passthrough (server-specific args, merged into the body).
 */
export type StartOptions = StartRequest & ExtensionOptions;
