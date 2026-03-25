import type { RunnerProtocol } from "../client/protocol.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

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

export interface ExecuteRequest {
  /** MTHDS bundle content(s) to validate, load, and execute. Omit to run an already-loaded pipe. */
  mthds_contents?: string[];
  pipe_code?: string;
  inputs?: Record<string, unknown>;
}

export interface ValidateRequest {
  /** GitHub URL or local path to the method directory (preferred). */
  method_url?: string;
  /** Pipe code to validate (optional — validates a specific pipe). */
  pipe_code?: string;
  /** Raw .mthds file content(s). */
  mthds_contents?: string[];
}

export interface ConceptRequest {
  spec: Record<string, unknown>;
}

export interface PipeSpecRequest {
  pipe_type: string;
  spec: Record<string, unknown>;
}

export interface CheckModelRequest {
  reference: string;
  type?: string;
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
  mthds_contents: string[];
  pipelex_bundle_blueprint: PipelexBundleBlueprint;
  success: boolean;
  message: string;
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

export interface CheckModelResponse {
  success: boolean;
  valid: boolean;
  reference: string;
  suggestions?: string[];
  [key: string]: unknown;
}

export interface ModelsRequest {
  type?: string[];
}

export interface ModelsResponse {
  success: boolean;
  presets: Record<string, Array<{ name: string; description?: string }>>;
  aliases: Record<string, Record<string, string>>;
  waterfalls: Record<string, Record<string, string[]>>;
  talent_mappings: Record<string, Record<string, string>>;
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
  buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse>;

  // Pipeline execution
  execute(request: ExecuteRequest): Promise<PipelineResponse>;

  // Validation
  validate(request: ValidateRequest): Promise<ValidateResponse>;

  // Spec-to-TOML
  concept(request: ConceptRequest): Promise<ConceptResponse>;
  pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse>;

  // Models
  models(request?: ModelsRequest): Promise<ModelsResponse>;
  checkModel(request: CheckModelRequest): Promise<CheckModelResponse>;
}
