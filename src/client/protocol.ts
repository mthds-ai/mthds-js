import type { RunOptions, RunResult, StartAck } from "./pipeline.js";
import type { StartOptions } from "./runs.js";
import type {
  ModelCategory,
  ModelDeck,
  ValidationReport,
  VersionInfo,
} from "./protocol-models.js";

/**
 * The MTHDS Protocol — the contract every MTHDS runner implements.
 *
 * Mirrors the standard's five routes (`mthds-protocol.openapi.yaml`):
 * `execute`, `start`, `validate`, `models`, `version`. A runner is just a
 * runner: it executes and validates methods, and reports its model deck and
 * version. Run polling is NOT part of the protocol — it is a hosted-API
 * extension carried by `MthdsApiClient` and the `Runner` interface only.
 */
export interface MTHDSProtocol {
  /**
   * Execute a method synchronously and wait for its completion.
   *
   * Throws `RunStillRunningError` if the server answers `202 + StartAck` (the
   * protocol's optional async degrade) instead of a final result.
   */
  execute(options: RunOptions): Promise<RunResult>;

  /**
   * Start a method asynchronously without waiting for completion.
   *
   * `options.pipeline_run_id` is bare-runner-only (hosted 422s it); `options.method_id`
   * is a hosted extension. The returned `StartAck.pipeline_run_id` is authoritative.
   */
  start(options: StartOptions): Promise<StartAck>;

  /**
   * Parse, validate, and dry-run an MTHDS bundle.
   *
   * Returns the structural artifacts of a VALID bundle; invalid bundles throw
   * (HTTP 422 problem on API runners). `allowSignatures` tolerates
   * unimplemented pipe signatures (strict by default).
   */
  validate(mthdsContents: string[], allowSignatures?: boolean): Promise<ValidationReport>;

  /** The model deck this runner can route to, optionally filtered by category. */
  models(category?: ModelCategory): Promise<ModelDeck>;

  /** Protocol + implementation versions — the handshake for feature detection. */
  version(): Promise<VersionInfo>;
}
