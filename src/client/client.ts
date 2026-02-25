import type { RunnerProtocol } from "./protocol.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineRequest,
  PipelineStartResponse,
} from "./pipeline.js";
import {
  ClientAuthenticationError,
  PipelineRequestError,
} from "./exceptions.js";

interface MthdsApiClientOptions {
  apiToken?: string;
  apiBaseUrl?: string;
}

export class MthdsApiClient implements RunnerProtocol {
  private readonly apiToken: string | undefined;
  private readonly apiBaseUrl: string;

  constructor(options: MthdsApiClientOptions = {}) {
    this.apiToken = options.apiToken ?? process.env.PIPELEX_API_KEY;

    const resolvedBaseUrl =
      options.apiBaseUrl ?? process.env.PIPELEX_API_URL;
    if (!resolvedBaseUrl) {
      throw new ClientAuthenticationError(
        "API base URL is required for API execution"
      );
    }
    this.apiBaseUrl = resolvedBaseUrl.replace(/\/+$/, "");
  }

  private async makeApiCall(
    endpoint: string,
    pipelineRequest: PipelineRequest
  ): Promise<unknown> {
    const url = `${this.apiBaseUrl}/${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(pipelineRequest),
      signal: AbortSignal.timeout(1_200_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new PipelineRequestError(
        `API POST /${endpoint} failed (${response.status}): ${text || response.statusText}`
      );
    }

    return response.json();
  }

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    if (!options.pipe_code && !options.mthds_content) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_content must be provided to executePipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_content: options.mthds_content,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_code: options.dynamic_output_concept_code,
    };

    const data = await this.makeApiCall("api/v1/pipeline/execute", request);
    return data as PipelineExecuteResponse;
  }

  async startPipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse> {
    if (!options.pipe_code && !options.mthds_content) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_content must be provided to startPipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_content: options.mthds_content,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_code: options.dynamic_output_concept_code,
    };

    const data = await this.makeApiCall("api/v1/pipeline/start", request);
    return data as PipelineStartResponse;
  }
}
