import {
  loadConfig,
  getConfigValue,
  findLegacyUrlKey,
  findLegacyApiKeyKey,
} from "../config/config.js";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
} from "./types.js";
import type { RunOptions, RunResult, StartAck } from "../client/pipeline.js";
import type {
  StartOptions,
  RunRead,
  RunResults,
  RunResultState,
  WaitForResultOptions,
} from "../client/runs.js";
import type {
  ModelCategory,
  ModelDeck,
  ValidationReport,
  VersionInfo,
} from "../client/protocol-models.js";
import { MthdsApiClient } from "../client/client.js";
import { ClientAuthenticationError } from "../client/exceptions.js";
import { BaseRunner } from "./base-runner.js";

/**
 * `VersionInfo.implementation` of the bare open-source runner (no run store).
 * Anything else — the hosted `pipelex-hosted` first — is assumed to serve the
 * durable run-lifecycle extension; a wrong guess still fails with the clear
 * `RunLifecycleUnavailableError` on the first poll.
 */
const BARE_RUNNER_IMPLEMENTATION = "pipelex-api";

export class ApiRunner extends BaseRunner implements Runner {
  readonly type: RunnerType = Runners.API;

  /** API base URL — host only; trailing slash stripped. Endpoints compose as `{base}/v1/{endpoint}`. */
  private readonly baseUrl: string;
  /** Origin root derived from the base URL — `/health` lives here, not under `/v1`. */
  private readonly originUrl: string;
  private readonly apiKey: string;
  /** Protocol + durable run-lifecycle transport. */
  private readonly client: MthdsApiClient;
  /** Cached `/v1/version` handshake outcome — whether the durable lifecycle is served. */
  private lifecycleAvailable: boolean | undefined;

  constructor(baseUrl?: string, apiKey?: string) {
    super();
    const config = loadConfig();

    // Fail fast (scoped to the api-runner path) when a NEW key is still at its
    // default AND a leftover legacy `PIPELEX_*` key is present — that user
    // upgraded across the rename and must migrate. These checks live here, not
    // in `loadConfig()`, so pure `pipelex`-runner flows and unrelated commands
    // are never blocked.
    const baseUrlIsExplicit =
      baseUrl !== undefined || getConfigValue("baseUrl").source !== "default";
    if (!baseUrlIsExplicit) {
      const legacyUrl = findLegacyUrlKey();
      if (legacyUrl) {
        throw new ClientAuthenticationError(legacyUrl.message);
      }
    }
    const apiKeyIsExplicit =
      apiKey !== undefined || getConfigValue("apiKey").source !== "default";
    if (!apiKeyIsExplicit) {
      const legacyKey = findLegacyApiKeyKey();
      if (legacyKey) {
        throw new ClientAuthenticationError(legacyKey.message);
      }
    }

    this.baseUrl = (baseUrl ?? config.baseUrl).replace(/\/+$/, "");
    this.originUrl = new URL("/", this.baseUrl).origin;
    this.apiKey = apiKey ?? config.apiKey;
    this.client = new MthdsApiClient({
      baseUrl: this.baseUrl,
      apiToken: this.apiKey || undefined,
    });
  }

  // ── HTTP helpers (build extensions + health) ─────────────────────

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

  /** Build an API URL: `{base}/v1/{path}`. */
  private apiUrl(path: string): string {
    return `${this.baseUrl}/v1/${path.replace(/^\/+/, "")}`;
  }

  private postApi<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", this.apiUrl(path), body);
  }

  // ── Health ────────────────────────────────────────────────────────

  async health(): Promise<Record<string, unknown>> {
    // `/health` is origin-level, NOT under the `/v1` prefix.
    return this.request("GET", `${this.originUrl}/health`);
  }

  // ── Protocol surface (delegated to the client) ────────────────────

  async execute(options: RunOptions): Promise<RunResult> {
    return this.client.execute(options);
  }

  async start(options: StartOptions): Promise<StartAck> {
    return this.client.start(options);
  }

  async validate(
    mthdsContents: string[],
    allowSignatures?: boolean
  ): Promise<ValidationReport> {
    return this.client.validate(mthdsContents, allowSignatures);
  }

  async models(category?: ModelCategory): Promise<ModelDeck> {
    return this.client.models(category);
  }

  async version(): Promise<VersionInfo> {
    return this.client.version();
  }

  // ── Build extensions (`/v1/build/*`) ──────────────────────────────

  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    return this.postApi("build/inputs", request);
  }

  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    return this.postApi("build/output", request);
  }

  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    return this.postApi("build/runner", request);
  }

  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    return this.postApi("build/concept", request);
  }

  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    return this.postApi("build/pipe-spec", request);
  }

  // ── Run lifecycle (hosted extension) ──────────────────────────────
  // Primitives delegate to the client; the `waitForResult` composite is
  // inherited from BaseRunner (polls getRunResult). On a bare runner these
  // throw `RunLifecycleUnavailableError` (the runner has no run store).

  async getRunStatus(runId: string): Promise<RunRead> {
    return this.client.getRunStatus(runId);
  }

  async getRunResult(
    runId: string,
    options?: { signal?: AbortSignal }
  ): Promise<RunResultState> {
    return this.client.getRunResult(runId, options);
  }

  /**
   * Whether the configured server serves the durable run lifecycle, decided
   * via the `GET /v1/version` handshake (master D2) and cached for the
   * runner's lifetime. A bare `pipelex-api` runner has no run store; anything
   * else is assumed hosted. When the handshake itself fails, assume hosted
   * (the SDK default) and let the start call surface the real error.
   */
  private async supportsRunLifecycle(): Promise<boolean> {
    if (this.lifecycleAvailable === undefined) {
      try {
        const info = await this.client.version();
        this.lifecycleAvailable = info.implementation !== BARE_RUNNER_IMPLEMENTATION;
      } catch {
        this.lifecycleAvailable = true;
      }
    }
    return this.lifecycleAvailable;
  }

  /**
   * Start a run and wait for its result.
   *
   * - **Hosted** (per the `/v1/version` handshake): durable start + poll (the
   *   BaseRunner composite), the path that survives the gateway's ~30s
   *   synchronous ceiling.
   * - **Bare runner** (no run store): the blocking `POST /v1/execute`, which
   *   has no gateway cap off-platform and returns the native `pipe_output`.
   */
  async startAndWaitForResult(
    options: StartOptions,
    pollOptions?: WaitForResultOptions
  ): Promise<RunResults> {
    if (await this.supportsRunLifecycle()) {
      return super.startAndWaitForResult(options, pollOptions);
    }

    const response = await this.client.execute({
      pipe_code: options.pipe_code ?? undefined,
      mthds_contents: options.mthds_contents ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
    });
    return mapRunResultToRunResults(response);
  }
}

/**
 * Map the protocol's blocking `POST /v1/execute` response onto the lifecycle's
 * `RunResults`. The bare-runner path returns `pipe_output` (native runner
 * shape); `main_stuff` is a hosted-durable artifact and stays null here.
 * Consumers read `main_stuff ?? pipe_output` (the documented hosted/bare
 * output-shape difference).
 */
function mapRunResultToRunResults(response: RunResult): RunResults {
  return {
    run_id: response.run_id,
    main_stuff: null,
    graph_spec: response.pipe_output?.graph_spec ?? null,
    pipe_output:
      (response.pipe_output as Record<string, unknown> | null | undefined) ?? null,
  };
}
