/**
 * Public SDK barrel — re-exports the MTHDS Protocol surface (`protocol/`) and
 * the API runner + run-lifecycle extension (`runners/api/`).
 *
 * Structural split (protocol ⊥ runners) parity with `mthds-python`:
 *   - `mthds/client/*` is gone. The protocol interface + wire models live in
 *     `protocol/`; the API client/runner, lifecycle polling, and Dict-serialized
 *     concretes live in `runners/api/`.
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
  RunFailedError,
  RunTimeoutError,
  RunStillRunningError,
  RunLifecycleUnavailableError,
} from "./runners/api/exceptions.js";

// ── Run lifecycle (runners/api — hosted extension, NOT protocol) ──────
export { isTerminalRunStatus, isSuccessRunStatus } from "./runners/api/runs.js";
export type {
  RunStatus,
  RunPublic,
  RunRead,
  RunResults,
  RunResultState,
  WaitForResultOptions,
} from "./runners/api/runs.js";

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
