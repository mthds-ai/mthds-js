import {
  pollUntilResult,
  type RunResults,
  type RunResultState,
  type WaitForResultOptions,
} from "./api/runs.js";
import type { StartOptions } from "../protocol/options.js";
import type { RunResultStart } from "../protocol/models.js";

/**
 * Shared base for every runner. Provides the two run-lifecycle COMPOSITES —
 * `waitForResult` (poll an existing run to completion) and
 * `startAndWaitForResult` (start a run, then wait for its result) — implemented
 * once over the abstract primitives `start` / `getRunResult`. Concrete runners
 * implement the primitives; a runtime with a faster blocking path (a bare
 * runner, the local pipelex CLI) overrides `startAndWaitForResult`.
 *
 * The composites are deliberately NOT part of the `Runner` contract's "must
 * implement" surface — every runner gets them for free here, so they can never
 * drift between runtimes.
 */
export abstract class BaseRunner {
  /** Start a run and return its 202 ack immediately (no waiting; no output yet). The returned `pipeline_run_id` is authoritative. */
  abstract start(options: StartOptions): Promise<RunResultStart>;

  /** Single-shot result lookup: running (202) / completed (200) / failed (409). */
  abstract getRunResult(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<RunResultState>;

  /** Poll an already-started run (by id) until it reaches a terminal state. */
  async waitForResult(
    runId: string,
    options?: WaitForResultOptions
  ): Promise<RunResults> {
    return pollUntilResult((id, opts) => this.getRunResult(id, opts), runId, options);
  }

  /** Start a run, then wait for its result — the one-call convenience. */
  async startAndWaitForResult(
    options: StartOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResults> {
    const ack = await this.start(options);
    return this.waitForResult(ack.pipeline_run_id, pollOptions);
  }
}
