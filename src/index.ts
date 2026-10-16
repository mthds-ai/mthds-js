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
export type {
  MthdsApiClientOptions,
  MthdsFile,
  ValidateFilesOptions,
} from "./runners/api/client.js";
export type { AppInfo } from "./runners/api/user-agent.js";
export { MTHDS_JS_VERSION } from "./version.js";

// ── Pipe I/O (runners — `MthdsApiClient.pipeIo`, a Pipelex API extension) ──
export { PIPE_SELECTION_CODES } from "./runners/types.js";
export type {
  CrateInvalidReport,
  CrateRequestBase,
  MthdsFileItem,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
} from "./runners/types.js";

// ── API-runner errors (runners/api — the protocol-base `PipelineRequestError`, the
//    `ProblemError` every one of them is, and the problem types ride the protocol
//    barrel above) ──────────────────────────────────────────────────────
export {
  ApiResponseError,
  ApiTransportError,
  RunStillRunningError,
} from "./runners/api/exceptions.js";
export type { AnswerReport, ApiAnswerFacts } from "./runners/api/exceptions.js";

// ── Dict-serialized concretes (runners/api) ──
//
// The Pipelex-API `/v1/validate` narrowing (`PipelexValidationResult` and its
// arms) is NOT exported here — it lives in the runtime SDK (`@pipelex/sdk`).
// `MthdsApiClient.validate()` returns the protocol's `ValidationResult`, whose
// faults are problem items (`ProblemItem`, re-exported via the protocol barrel above).
export type {
  DictStuff,
  DictWorkingMemory,
  DictPipeOutput,
  DictRunResultExecute,
} from "./runners/api/models.js";

// ── Method tree (src/method-tree — Node-side: listing reads the file system) ──
export * from "./method-tree/index.js";
