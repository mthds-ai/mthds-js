import type { DictPipeOutput } from "./models/pipe_output.js";
import type { VariableMultiplicity } from "./models/pipe_output.js";
import type { PipelineInputs } from "./models/pipeline_inputs.js";

// ── Run state ──────────────────────────────────────────────────────

/** Run lifecycle state — mirrors the protocol's `RunState` enum. */
export type RunState =
  | "STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR";

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
 * Body of the protocol's `POST /start` — `RunRequest` plus the async extras.
 *
 * Mirrors `StartRequest` in `mthds-protocol.openapi.yaml`, with the hosted
 * `method_id` extension.
 */
export interface StartRequest extends RunRequest {
  /**
   * Client-supplied run identifier — bare runners only. The hosted API always
   * generates the id server-side and rejects a client-supplied one with 422
   * (never silently ignores it). `StartAck.run_id` is always authoritative.
   */
  run_id?: string | null;
  /**
   * Completion webhooks, HMAC-signed by the runner via
   * `X-Completion-Signature`. http/https only; private/loopback/metadata
   * hosts are rejected server-side.
   */
  callback_urls?: string[] | null;
  /**
   * HOSTED EXTENSION — id of a stored method in the active org's catalog,
   * mutually exclusive with `mthds_contents`. Bare runners do not implement it.
   */
  method_id?: string | null;
}

// ── Responses ──────────────────────────────────────────────────────

/**
 * Result of a completed execution — `POST /execute` 200 and callback
 * payloads. Mirrors the protocol's `RunResult`.
 */
export interface RunResult {
  run_id: string;
  created_at: string;
  state: RunState;
  finished_at?: string | null;
  main_stuff_name?: string | null;
  /** The method's full output working memory (serialized stuffs). */
  pipe_output?: DictPipeOutput | null;
}

/**
 * Ack of a started execution — `POST /start` 202 (and the protocol's
 * optional `POST /execute` 202 degrade). `run_id` is always authoritative.
 */
export interface StartAck {
  run_id: string;
  created_at: string;
  state: RunState;
}

// ── Method options ─────────────────────────────────────────────────

/**
 * Options for `MTHDSProtocol.execute` — the `RunRequest` fields. (The options
 * surface and the wire body are intentionally the same shape.)
 */
export type RunOptions = RunRequest;
