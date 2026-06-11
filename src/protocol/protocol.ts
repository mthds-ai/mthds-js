import type { RunOptions, StartOptions } from "./options.js";
import type {
  ModelCategory,
  ModelDeck,
  RunResultExecute,
  RunResultStart,
  ValidationReport,
  VersionInfo,
} from "./models.js";

/**
 * The MTHDS Protocol — the contract every MTHDS runner implements. Exact
 * mirror of `mthds/protocol/protocol.py` (`MTHDSProtocol`, generic in the
 * pipe-output type).
 *
 * Mirrors the standard's five routes (`mthds-protocol.openapi.yaml`):
 * `execute`, `start`, `validate`, `models`, `version`. A runner is just a
 * runner: it executes and validates methods, and reports its model deck and
 * version. Run polling is NOT part of the protocol — it is a hosted-API
 * extension carried by `MthdsApiClient` and the `Runner` interface only.
 *
 * Generic in `PipeOutputT` (mirroring python's `Generic[PipeOutputT]`): the
 * generic is the mechanism that keeps `protocol/` pure — `execute` returns
 * `RunResultExecute<PipeOutputT>` without the protocol ever naming the
 * runner-side `DictPipeOutput` concrete.
 */
export interface MTHDSProtocol<PipeOutputT = unknown> {
  /**
   * Execute a method synchronously and wait for its completion.
   *
   * Throws `RunStillRunningError` if the server answers 202 (the
   * protocol's optional async degrade) instead of a final result.
   */
  execute(options: RunOptions): Promise<RunResultExecute<PipeOutputT>>;

  /**
   * Start a method asynchronously without waiting for completion.
   *
   * Carries the protocol's basic arguments only; server-specific extension
   * args ride `options.extra`. Returns `RunResultStart` — the authoritative
   * server-generated `pipeline_run_id`, no output yet.
   */
  start(options: StartOptions): Promise<RunResultStart>;

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
