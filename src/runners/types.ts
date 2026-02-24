import type { RunnerProtocol } from "../client/protocol.js";

// ── Runner type ─────────────────────────────────────────────────────
export type RunnerType = "api" | "pipelex";

// ── Shared enums / literals ─────────────────────────────────────────

export type PipelineState =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR"
  | "STARTED";

export type ConceptRepresentationFormat = "json" | "python" | "schema";

// ── Request types ───────────────────────────────────────────────────

export interface BuildInputsRequest {
  plx_content: string;
  pipe_code: string;
}

export interface BuildOutputRequest {
  plx_content: string;
  pipe_code: string;
  format?: ConceptRepresentationFormat;
}

export interface BuildPipeRequest {
  brief: string;
  output?: string;
}

export interface BuildRunnerRequest {
  plx_content: string;
  pipe_code: string;
}

export interface ExecuteRequest {
  /** PLX content to validate, load, and execute. Omit to run an already-loaded pipe. */
  plx_content?: string;
  pipe_code?: string;
  inputs?: Record<string, unknown>;
}

export interface ValidateRequest {
  plx_content: string;
}

// ── Response types ──────────────────────────────────────────────────

export interface BuildPipeResponse {
  plx_content: string;
  pipelex_bundle_blueprint: Record<string, unknown>;
  success: boolean;
  message: string;
}

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

export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  graph_spec?: unknown;
  pipeline_run_id: string;
}

export interface PipelineResponse {
  pipeline_run_id: string;
  created_at: string;
  pipeline_state: PipelineState;
  finished_at?: string | null;
  pipe_output?: DictPipeOutput | null;
  main_stuff_name?: string | null;
}

export interface PipelexBundleBlueprint {
  source?: string | null;
  domain: string;
  description?: string | null;
  system_prompt?: string | null;
  main_pipe?: string | null;
  concept?: Record<string, unknown> | null;
  pipe?: Record<string, unknown> | null;
}

export interface ValidateResponse {
  plx_content: string;
  pipelex_bundle_blueprint: PipelexBundleBlueprint;
  success: boolean;
  message: string;
}

// ── Runner interface ────────────────────────────────────────────────
// Every runtime (API, local pipelex CLI, …) must implement this.

export interface Runner extends RunnerProtocol {
  readonly type: RunnerType;

  // Health & version
  health(): Promise<Record<string, unknown>>;
  version(): Promise<Record<string, string>>;

  // Build
  buildInputs(request: BuildInputsRequest): Promise<unknown>;
  buildOutput(request: BuildOutputRequest): Promise<unknown>;
  buildPipe(request: BuildPipeRequest): Promise<BuildPipeResponse>;
  buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse>;

  // Pipeline execution
  execute(request: ExecuteRequest): Promise<PipelineResponse>;

  // Validation
  validate(request: ValidateRequest): Promise<ValidateResponse>;
}
