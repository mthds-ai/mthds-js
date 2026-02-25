import { loadConfig } from "../config/config.js";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildPipeRequest,
  BuildPipeResponse,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ExecuteRequest,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
} from "./types.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineStartResponse,
} from "../client/pipeline.js";

export class ApiRunner implements Runner {
  readonly type: RunnerType = Runners.API;

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    const config = loadConfig();
    this.baseUrl = (baseUrl ?? config.apiUrl).replace(/\/+$/, "");
    this.apiKey = apiKey ?? config.apiKey;
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
    return this.get("/api/v1/pipelex_version");
  }

  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    return this.post("/api/v1/build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    return this.post("/api/v1/build/output", request);
  }

  async buildPipe(request: BuildPipeRequest): Promise<BuildPipeResponse> {
    return this.post("/api/v1/build/pipe", request);
  }

  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    return this.post("/api/v1/build/runner", request);
  }

  async execute(request: ExecuteRequest): Promise<PipelineResponse> {
    return this.post("/api/v1/pipeline/execute", request);
  }

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    return this.post("/api/v1/validate", request);
  }

  // ── RunnerProtocol implementation ─────────────────────────────────

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    return this.post("/api/v1/pipeline/execute", options);
  }

  async startPipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse> {
    return this.post("/api/v1/pipeline/start", options);
  }
}
