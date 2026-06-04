import type { DictPipeOutput } from "./models/pipe_output.js";
import type { VariableMultiplicity } from "./models/pipe_output.js";
import type { PipelineInputs } from "./models/pipeline_inputs.js";

export type { PipelineState } from "../runners/types.js";

// ── Request ────────────────────────────────────────────────────────

export interface PipelineRequest {
  pipe_code?: string | null;
  mthds_contents?: string[] | null;
  inputs?: PipelineInputs | null;
  output_name?: string | null;
  output_multiplicity?: VariableMultiplicity | null;
  dynamic_output_concept_code?: string | null;
}

// ── Responses ──────────────────────────────────────────────────────

export interface PipelineExecuteResponse {
  pipeline_run_id: string;
  created_at: string;
  pipeline_state: string;
  finished_at?: string | null;
  main_stuff_name?: string | null;
  /**
   * Full pipe output (working memory). Present on the runner's blocking
   * `/pipeline/execute` path; `null` on the durable platform polling path,
   * which returns `main_stuff` + `graph_spec` instead.
   */
  pipe_output?: DictPipeOutput | null;
  /** Main output stuff (`main_stuff.json`) — set on the platform polling path. */
  main_stuff?: Record<string, unknown> | null;
  /** Pipeline graph spec (`graphspec.json`) — set on the platform polling path. */
  graph_spec?: Record<string, unknown> | null;
}

export interface PipelineStartResponse {
  pipeline_run_id: string;
  created_at: string;
  pipeline_state: string;
  finished_at?: string | null;
  main_stuff_name?: string | null;
  pipe_output?: DictPipeOutput | null;
}

// ── Method options ─────────────────────────────────────────────────

export interface ExecutePipelineOptions {
  pipe_code?: string | null;
  mthds_contents?: string[] | null;
  inputs?: PipelineInputs | null;
  output_name?: string | null;
  output_multiplicity?: VariableMultiplicity | null;
  dynamic_output_concept_code?: string | null;
}
