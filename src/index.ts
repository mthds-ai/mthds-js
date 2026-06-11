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
 */

// ── API runner / client (runners/api) ────────────────────────────────
export { MthdsApiClient, DEFAULT_API_BASE_URL } from "./runners/api/client.js";

// ── Protocol interface (protocol) ────────────────────────────────────
export type { MTHDSProtocol } from "./protocol/protocol.js";

// ── Exceptions (protocol base + api-runner errors) ───────────────────
export { PipelineRequestError } from "./protocol/exceptions.js";
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

// ── Request/options surface (protocol) ───────────────────────────────
export type {
  RunRequest,
  StartRequest,
  RunOptions,
  StartOptions,
  ExtensionOptions,
} from "./protocol/options.js";

// ── Wire models (protocol) ───────────────────────────────────────────
export { MTHDS_PROTOCOL_VERSION, MODEL_CATEGORIES } from "./protocol/models.js";
export type {
  RunResultExecute,
  RunResultStart,
  ModelCategory,
  ModelInfo,
  ModelDeck,
  ValidationReport,
  VersionInfo,
} from "./protocol/models.js";
export type { VariableMultiplicity, PipeOutputAbstract } from "./protocol/pipe_output.js";
export type { StuffContentOrData, PipelineInputs } from "./protocol/pipeline_inputs.js";

// ── Abstract domain shapes (protocol — exact mirror of mthds-python) ──
export { conceptRef } from "./protocol/concept.js";
export type { ConceptAbstract } from "./protocol/concept.js";
export type { StuffAbstract, StuffContentAbstract } from "./protocol/stuff.js";
export type { WorkingMemoryAbstract } from "./protocol/working_memory.js";

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

// ── Dict-serialized concretes (runners/api) ──────────────────────────
export type {
  DictStuff,
  DictWorkingMemory,
  DictPipeOutput,
  DictRunResultExecute,
} from "./runners/api/models.js";
