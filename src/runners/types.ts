import type { MTHDSProtocol } from "../protocol/protocol.js";
import type { DictPipeOutput } from "./api/models.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

// ── Shared enums / literals ─────────────────────────────────────────

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
// extensions. The durable run-lifecycle (poll a run by id) is NOT part of this
// interface — it now lives in the Pipelex runtime SDK (`@pipelex/sdk`).

export interface Runner extends MTHDSProtocol<DictPipeOutput> {
  readonly type: RunnerType;

  // Health — origin-level `/health` on the API runner, local doctor on pipelex.
  health(): Promise<Record<string, unknown>>;

  // Build extensions (Pipelex API layer 2 — `/v1/build/*`)
  buildInputs(request: BuildInputsRequest): Promise<unknown>;
  buildOutput(request: BuildOutputRequest): Promise<unknown>;
  buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse>;
  concept(request: ConceptRequest): Promise<ConceptResponse>;
  pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse>;
}
