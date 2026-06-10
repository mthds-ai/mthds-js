import {
  loadConfig,
  getConfigValue,
  hasLegacyApiUrl,
  LEGACY_API_URL_MIGRATION_MESSAGE,
} from "../config/config.js";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
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
} from "../client/pipeline.js";
import type { PipelineInputs } from "../client/models/pipeline_inputs.js";
import type {
  StartRunOptions,
  RunPublic,
  RunRead,
  RunResult,
  RunResultState,
  WaitForResultOptions,
} from "../client/runs.js";
import { MthdsApiClient } from "../client/client.js";
import { ClientAuthenticationError } from "../client/exceptions.js";
import { BaseRunner } from "./base-runner.js";

export class ApiRunner extends BaseRunner implements Runner {
  readonly type: RunnerType = Runners.API;

  /** Runner base URL, INCLUDING its version prefix; trailing slash stripped. */
  private readonly runnerBaseUrl: string;
  /** Origin root derived from the runner base — `/health` lives here. */
  private readonly originUrl: string;
  /** Platform base URL (durable runs); undefined in self-hosted mode. */
  private readonly platformBaseUrl: string | undefined;
  private readonly apiKey: string;
  /** Runner + durable run-lifecycle transport. */
  private readonly client: MthdsApiClient;

  constructor(runnerUrl?: string, apiKey?: string, platformUrl?: string) {
    super();
    const config = loadConfig();

    // Fail fast (scoped to the api-runner path) when the runner URL is still
    // the hosted default AND a leftover legacy `apiUrl`/`PIPELEX_API_URL` is
    // present — that user upgraded across the rename and must migrate. This
    // check lives here, not in `loadConfig()`, so pure `pipelex`-runner flows
    // and unrelated commands are never blocked.
    const runnerUrlIsExplicit =
      runnerUrl !== undefined || isRunnerUrlExplicitlySet();
    if (!runnerUrlIsExplicit && hasLegacyApiUrl()) {
      throw new ClientAuthenticationError(LEGACY_API_URL_MIGRATION_MESSAGE);
    }

    this.runnerBaseUrl = (runnerUrl ?? config.runnerUrl).replace(/\/+$/, "");
    this.originUrl = new URL("/", this.runnerBaseUrl).origin;

    const resolvedPlatform = platformUrl ?? config.platformUrl;
    this.platformBaseUrl = resolvedPlatform
      ? resolvedPlatform.replace(/\/+$/, "")
      : undefined;

    this.apiKey = apiKey ?? config.apiKey;
    this.client = new MthdsApiClient({
      runnerBaseUrl: this.runnerBaseUrl,
      platformBaseUrl: this.platformBaseUrl,
      apiToken: this.apiKey || undefined,
    });
  }

  /** Whether the durable platform surface is configured (hosted) or not (self-hosted). */
  private hasPlatform(): boolean {
    return this.platformBaseUrl !== undefined;
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown
  ): Promise<T> {
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
        `API ${method} ${url} failed (${res.status}): ${text || res.statusText}`
      );
    }

    return res.json() as Promise<T>;
  }

  /**
   * Build a runner URL. `path` is appended to the runner base URL (which
   * already carries its version prefix `/runner/v1` or `/api/v1`) — do NOT
   * re-prefix it here.
   */
  private runnerUrl(path: string): string {
    return `${this.runnerBaseUrl}/${path.replace(/^\/+/, "")}`;
  }

  private getRunner<T>(path: string): Promise<T> {
    return this.request("GET", this.runnerUrl(path));
  }

  private postRunner<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", this.runnerUrl(path), body);
  }

  // ── Runner implementation ───────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    // `/health` is origin-level, NOT under the version prefix.
    return this.request("GET", `${this.originUrl}/health`);
  }

  async version(): Promise<Record<string, string>> {
    return this.getRunner("pipelex_version");
  }

  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    return this.postRunner("build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    return this.postRunner("build/output", request);
  }

  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    return this.postRunner("build/runner", request);
  }

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    return this.postRunner("validate", request);
  }

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.postRunner("build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.postRunner("build/pipe-spec", request);
  }

  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    return this.postRunner("check-model", request);
  }

  async models(request?: ModelsRequest): Promise<ModelsResponse> {
    const params = new URLSearchParams();
    if (request?.type) {
      for (const t of request.type) {
        params.append("type", t);
      }
    }
    const qs = params.toString();
    return this.getRunner(qs ? `models?${qs}` : "models");
  }

  // ── Run lifecycle ───────────────────────────────────────────────
  // Primitives. The durable surface resolves to the platform when configured,
  // else the runner's own `/runs` endpoints (see MthdsApiClient). The
  // `waitForResult` composite is inherited from BaseRunner (polls getResult).

  async start(options: StartRunOptions): Promise<RunPublic> {
    return this.client.startRun(options);
  }

  async getRun(runId: string): Promise<RunRead> {
    return this.client.getRun(runId);
  }

  async getResult(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<RunResultState> {
    return this.client.getResult(runId, options);
  }

  /**
   * Start a run and wait for its result.
   *
   * - **Hosted** (platform configured): durable start + poll (BaseRunner
   *   composite), the path that survives the gateway's ~30s synchronous ceiling.
   * - **Self-hosted** (no platform / no run store): the runner's blocking
   *   `/pipeline/execute`, which has no gateway cap off-platform and returns the
   *   native `pipe_output`.
   */
  async startAndWaitForResult(
    options: StartRunOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResult> {
    if (this.hasPlatform()) {
      return super.startAndWaitForResult(options, pollOptions);
    }

    const response = await this.client.executePipeline({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: (options.inputs as PipelineInputs | null | undefined) ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_code: options.dynamic_output_concept_ref ?? undefined,
    });
    return mapExecuteResponseToRunResult(response);
  }
}

/**
 * Whether `runnerUrl` was explicitly configured (env or file) rather than left
 * at the hosted default. Used by the constructor to decide whether a leftover
 * legacy `apiUrl` should trigger the migration fail-fast.
 */
function isRunnerUrlExplicitlySet(): boolean {
  return getConfigValue("runnerUrl").source !== "default";
}

/**
 * Map the runner's native blocking `/pipeline/execute` response onto a
 * `RunResult`. The self-hosted path returns `pipe_output` (native runner shape);
 * `main_stuff`/`graph_spec` are platform-durable artifacts and stay null here.
 * Consumers read `main_stuff ?? pipe_output` (the documented hosted/self-hosted
 * output-shape difference).
 */
function mapExecuteResponseToRunResult(
  response: PipelineExecuteResponse
): RunResult {
  return {
    pipeline_run_id: response.pipeline_run_id,
    main_stuff: response.main_stuff ?? null,
    graph_spec: response.graph_spec ?? null,
    pipe_output:
      (response.pipe_output as Record<string, unknown> | null | undefined) ?? null,
  };
}
