import type { RunOptions, StartOptions } from "./options.js";
import type {
  ModelCategory,
  ModelDeck,
  RunResultExecute,
  RunResultStart,
  ValidationResult,
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
 * extension that now lives in the Pipelex runtime SDK (`@pipelex/sdk` /
 * `pipelex-agent`), not in this package.
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
   * `/validate` is a diagnostic endpoint: it returns a {@link ValidationResult}
   * discriminated on `is_valid` — the structural artifacts of a VALID bundle, or
   * the `validation_errors[]` of an INVALID one. An invalid bundle is a produced
   * verdict (a 200 on API runners), NOT a thrown error; only a *no-verdict*
   * condition (a malformed request, auth, a server fault) throws. `allowSignatures`
   * tolerates unimplemented pipe signatures (strict by default) — they surface as
   * `pending_signatures` + `is_runnable`, never as an error.
   *
   * (A local CLI runner may instead raise on an invalid bundle rather than
   * materialize the invalid arm — the union is the wire shape, not a guarantee
   * that every runtime returns both arms.)
   */
  validate(mthdsContents: string[], allowSignatures?: boolean): Promise<ValidationResult>;

  /** The model deck this runner can route to, optionally filtered by category. */
  models(category?: ModelCategory): Promise<ModelDeck>;

  /** Protocol + implementation versions — the handshake for feature detection. */
  version(): Promise<VersionInfo>;
}
