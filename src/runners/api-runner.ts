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

/**
 * Format an error message from a non-2xx response. The pipelex-api emits
 * RFC 7807 `application/problem+json` for every error; extract `title` and
 * `detail` so callers see a human-readable message instead of opaque JSON.
 * Falls back to status + body text on parse failure or non-RFC-7807 bodies.
 */
function formatApiError(
  method: string,
  path: string,
  res: Response,
  text: string
): string {
  const prefix = `API ${method} ${path} failed (${res.status})`;
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("application/problem+json") && text) {
    try {
      const problem = JSON.parse(text) as {
        title?: unknown;
        detail?: unknown;
      };
      const title = typeof problem.title === "string" ? problem.title : "";
      const detail = typeof problem.detail === "string" ? problem.detail : "";
      if (title && detail) return `${prefix} — ${title}: ${detail}`;
      if (title) return `${prefix} — ${title}`;
      if (detail) return `${prefix} — ${detail}`;
    } catch {
      // Fall through to the raw-text fallback below.
    }
  }

  return `${prefix}: ${text || res.statusText}`;
}

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
      throw new Error(formatApiError(method, path, res, text));
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

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.post("/api/v1/build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.post("/api/v1/build/pipe-spec", request);
  }

  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    return this.post("/api/v1/check-model", request);
  }

  async models(request?: ModelsRequest): Promise<ModelsResponse> {
    const params = new URLSearchParams();
    if (request?.type) {
      for (const t of request.type) {
        params.append("type", t);
      }
    }
    const qs = params.toString();
    const path = qs ? `/api/v1/models?${qs}` : "/api/v1/models";
    return this.get(path);
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
