import type { MTHDSProtocol } from "../client/protocol.js";
import type {
  StartOptions,
  RunRead,
  RunResultState,
  RunResults,
  WaitForResultOptions,
} from "../client/runs.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

// ── Shared enums / literals ─────────────────────────────────────────

export type { RunState } from "../client/pipeline.js";

export type ConceptRepresentationFormat = "json" | "python" | "schema";

// ── Request types ───────────────────────────────────────────────────

export interface BuildInputsRequest {
  mthds_contents: string[];
  pipe_code: string;
}

export interface BuildOutputRequest {
  mthds_contents: string[];
  pipe_code: string;
  format?: ConceptRepresentationFormat;
}

export interface BuildRunnerRequest {
  mthds_contents: string[];
  pipe_code: string;
}

export interface ConceptRequest {
  spec: Record<string, unknown>;
}

export interface PipeSpecRequest {
  pipe_type: string;
  spec: Record<string, unknown>;
}

/** Request for `PipelexRunner.checkModel` — a LOCAL CLI capability only (no API route). */
export interface CheckModelRequest {
  reference: string;
  type: string;
  format?: string;
}

// ── Response types ──────────────────────────────────────────────────

export interface BuildRunnerResponse {
  python_code: string;
  pipe_code: string;
  success: boolean;
  message: string;
}

export interface DictStuff {
  concept: string;
  content: unknown;
}

export interface DictWorkingMemory {
  root: Record<string, DictStuff>;
  aliases: Record<string, string>;
}

/**
 * Serialized pipe output (working memory). NOTE: the inner `pipeline_run_id`
 * is a runtime-internal field produced by the pipelex runtime inside the
 * `pipe_output` payload — it deliberately keeps its name (master plan D1:
 * runtime internals are out of the wire-rename scope, matching mthds-python).
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  graph_spec?: unknown;
  pipeline_run_id: string;
}

export interface ConceptResponse {
  success: boolean;
  concept_code: string;
  toml: string;
}

export interface PipeSpecResponse {
  success: boolean;
  pipe_code: string;
  pipe_type: string;
  toml: string;
}

/** Response of `PipelexRunner.checkModel` — a LOCAL CLI capability only (no API route). */
export interface CheckModelResponse {
  success: boolean;
  valid: boolean;
  reference: string;
  suggestions?: string[];
  [key: string]: unknown;
}

// ── Runner interface ────────────────────────────────────────────────
// Every runtime (API, local pipelex CLI, …) implements the MTHDS Protocol
// (execute / start / validate / models / version) plus the Pipelex build
// extensions and the durable run-lifecycle FEATURE (hosted-API extension —
// explicitly NOT part of the protocol). The two lifecycle composites
// (`waitForResult`, `startAndWaitForResult`) are provided once by `BaseRunner`
// over the primitives, so concrete runners only implement the primitives.

export interface Runner extends MTHDSProtocol {
  readonly type: RunnerType;

  // Health — origin-level `/health` on the API runner, local doctor on pipelex.
  health(): Promise<Record<string, unknown>>;

  // Build extensions (Pipelex API layer 2 — `/v1/build/*`)
  buildInputs(request: BuildInputsRequest): Promise<unknown>;
  buildOutput(request: BuildOutputRequest): Promise<unknown>;
  buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse>;
  concept(request: ConceptRequest): Promise<ConceptResponse>;
  pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse>;

  // Run lifecycle (hosted extension, `/v1/runs/*` — NOT protocol)
  // Primitives:
  getRunStatus(runId: string): Promise<RunRead>;
  getRunResult(runId: string, options?: { signal?: AbortSignal }): Promise<RunResultState>;
  // Composites (provided by BaseRunner):
  waitForResult(runId: string, options?: WaitForResultOptions): Promise<RunResults>;
  startAndWaitForResult(
    options: StartOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResults>;
}
