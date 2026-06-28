/**
 * Public SDK barrel — re-exports the MTHDS Protocol surface (`protocol/`) and
 * the API runner (`runners/api/`).
 *
 * Structural split (protocol ⊥ runners) parity with `mthds-python`:
 *   - `mthds/client/*` is gone. The protocol interface + wire models live in
 *     `protocol/`; the API client/runner and the Dict-serialized concretes live
 *     in `runners/api/`. The durable run-lifecycle (poll-by-id) lives in the
 *     Pipelex runtime SDK (`@pipelex/sdk`), not here.
 *   - The single run response `RunResult` is split into `RunResultExecute<T>`
 *     (execute — has `pipe_output`) and `RunResultStart` (start — id only).
 *
 * The pure protocol surface is re-exported wholesale from the `protocol/` barrel
 * (`./protocol/index.js`, also published as the `mthds/protocol` subpath) so the
 * two entry points cannot drift. This file adds only the runner-side surface.
 */

// ── Pure MTHDS Protocol surface (also published as `mthds/protocol`) ──
export * from "./protocol/index.js";

// ── API runner / client (runners/api) ────────────────────────────────
export { MthdsApiClient, DEFAULT_API_BASE_URL } from "./runners/api/client.js";
export type { MthdsFile, ValidateFilesOptions } from "./runners/api/client.js";

// ── API-runner errors (runners/api — the protocol-base `PipelineRequestError`
//    rides the protocol barrel above) ──────────────────────────────────
export {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineExecuteTimeoutError,
  RunStillRunningError,
} from "./runners/api/exceptions.js";

// ── Dict-serialized concretes + Pipelex-API validate types (runners/api) ──
export type {
  DictStuff,
  DictWorkingMemory,
  DictPipeOutput,
  DictRunResultExecute,
  PipelexValidationReport,
  PipelexInvalidReport,
  PipelexValidationResult,
  ValidatedPipeEntry,
  DryRunStatus,
  ValidationErrorItem,
  ValidationErrorCategory,
} from "./runners/api/models.js";
