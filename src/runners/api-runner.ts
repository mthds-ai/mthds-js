import { loadConfig } from "../config/config.js";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ExecuteRequest,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
  CheckModelRequest,
  CheckModelResponse,
  ModelsRequest,
  ModelsResponse,
} from "./types.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineStartResponse,
} from "../client/pipeline.js";
import type {
  StartRunOptions,
  RunPublic,
  RunRead,
  RunResult,
  RunResultState,
  RunStatus,
  WaitForResultOptions,
} from "../client/runs.js";
import { MthdsApiClient } from "../client/client.js";

export class ApiRunner implements Runner {
  readonly type: RunnerType = Runners.API;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** Durable run-lifecycle transport (platform surface). */
  private readonly client: MthdsApiClient;

  constructor(baseUrl?: string, apiKey?: string) {
    const config = loadConfig();
    this.baseUrl = (baseUrl ?? config.apiUrl).replace(/\/+$/, "");
    this.apiKey = apiKey ?? config.apiKey;
    this.client = new MthdsApiClient({
      apiBaseUrl: this.baseUrl,
      apiToken: this.apiKey || undefined,
    });
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `API ${method} ${path} failed (${res.status}): ${text || res.statusText}`
      );
    }

    return res.json() as Promise<T>;
  }

  private get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  // ── Runner implementation ───────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    return this.get("/health");
  }

  async version(): Promise<Record<string, string>> {
    return this.get("/runner/v1/pipelex_version");
  }

  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    return this.post("/runner/v1/build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    return this.post("/runner/v1/build/output", request);
  }

  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    return this.post("/runner/v1/build/runner", request);
  }

  async execute(request: ExecuteRequest): Promise<PipelineResponse> {
    // Durable path: start a run on the platform and poll to terminal, instead
    // of the runner's blocking `/pipeline/execute` (which dies at the gateway's
    // 30s ceiling on real, long-running pipelines).
    const run = await this.client.startRun({
      pipe_code: request.pipe_code ?? "",
      mthds_contents: request.mthds_contents,
      inputs: request.inputs,
    });
    const result = await this.client.waitForResult(run.pipeline_run_id);
    return {
      pipeline_run_id: run.pipeline_run_id,
      created_at: run.created_at,
      pipeline_state: "COMPLETED",
      finished_at: run.finished_at ?? null,
      pipe_output: null,
      main_stuff: result.main_stuff ?? null,
      graph_spec: result.graph_spec ?? null,
    };
  }

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    return this.post("/runner/v1/validate", request);
  }

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.post("/runner/v1/build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.post("/runner/v1/build/pipe-spec", request);
  }

  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    return this.post("/runner/v1/check-model", request);
  }

  async models(request?: ModelsRequest): Promise<ModelsResponse> {
    const params = new URLSearchParams();
    if (request?.type) {
      for (const t of request.type) {
        params.append("type", t);
      }
    }
    const qs = params.toString();
    const path = qs ? `/runner/v1/models?${qs}` : "/runner/v1/models";
    return this.get(path);
  }

  // ── Run lifecycle (durable, platform surface) ─────────────────────

  async startRun(options: StartRunOptions): Promise<RunPublic> {
    return this.client.startRun(options);
  }

  async getRun(runId: string): Promise<RunRead> {
    return this.client.getRun(runId);
  }

  async getResult(runId: string): Promise<RunResultState> {
    return this.client.getResult(runId);
  }

  async waitForResult(
    runId: string,
    options?: WaitForResultOptions
  ): Promise<RunResult> {
    return this.client.waitForResult(runId, options);
  }

  // ── RunnerProtocol implementation ─────────────────────────────────

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    // Durable path (start + poll), same as `execute()`. The runner's blocking
    // `/pipeline/execute` is reachable via `MthdsApiClient.executePipeline` for
    // short, sub-30s runs, but the runner abstraction defaults to the path that
    // survives long runs.
    const run = await this.client.startRun({
      pipe_code: options.pipe_code ?? "",
      mthds_contents: options.mthds_contents,
      inputs: (options.inputs as Record<string, unknown> | null | undefined) ?? undefined,
    });
    const result = await this.client.waitForResult(run.pipeline_run_id);
    return {
      pipeline_run_id: run.pipeline_run_id,
      created_at: run.created_at,
      pipeline_state: "COMPLETED",
      finished_at: run.finished_at ?? null,
      pipe_output: null,
      main_stuff: result.main_stuff ?? null,
      graph_spec: result.graph_spec ?? null,
    };
  }

  async startPipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse> {
    const run = await this.client.startRun({
      pipe_code: options.pipe_code ?? "",
      mthds_contents: options.mthds_contents,
      inputs: (options.inputs as Record<string, unknown> | null | undefined) ?? undefined,
    });
    return {
      pipeline_run_id: run.pipeline_run_id,
      created_at: run.created_at,
      pipeline_state: mapRunStatusToPipelineState(run.status),
      finished_at: run.finished_at ?? null,
      main_stuff_name: null,
      pipe_output: null,
    };
  }
}

/** Map the platform's richer `RunStatus` onto the runner's `PipelineState`. */
function mapRunStatusToPipelineState(
  status: RunStatus
): PipelineStartResponse["pipeline_state"] {
  switch (status) {
    case "PENDING":
    case "STARTED":
      return "STARTED";
    case "RUNNING":
      return "RUNNING";
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    case "FAILED":
    case "TERMINATED":
    case "TIMED_OUT":
      return "FAILED";
  }
}
