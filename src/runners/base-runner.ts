import {
  pollUntilResult,
  type StartRunOptions,
  type RunPublic,
  type RunResult,
  type RunResultState,
  type WaitForResultOptions,
} from "../client/runs.js";

/**
 * Shared base for every runner. Provides the two run-lifecycle COMPOSITES —
 * `waitForResult` (poll an existing run to completion) and
 * `startAndWaitForResult` (start a run, then wait for its result) — implemented
 * once over the abstract primitives `start` / `getResult`. Concrete runners
 * implement the primitives; a runtime with a faster blocking path (the
 * self-hosted runner, the local pipelex CLI) overrides `startAndWaitForResult`.
 *
 * The composites are deliberately NOT part of the `Runner` contract's "must
 * implement" surface — every runner gets them for free here, so they can never
 * drift between runtimes.
 */
export abstract class BaseRunner {
  /** Start a run and return its record immediately (no waiting). */
  abstract start(options: StartRunOptions): Promise<RunPublic>;

  /** Single-shot result lookup: running (202) / completed (200) / failed (409). */
  abstract getResult(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<RunResultState>;

  /** Poll an already-started run (by id) until it reaches a terminal state. */
  async waitForResult(
    runId: string,
    options?: WaitForResultOptions
  ): Promise<RunResult> {
    return pollUntilResult((id, opts) => this.getResult(id, opts), runId, options);
  }

  /** Start a run, then wait for its result — the one-call convenience. */
  async startAndWaitForResult(
    options: StartRunOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResult> {
    const run = await this.start(options);
    return this.waitForResult(run.pipeline_run_id, pollOptions);
  }
}
