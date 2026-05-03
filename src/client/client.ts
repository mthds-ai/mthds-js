import type { RunnerProtocol } from "./protocol.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineRequest,
  PipelineStartResponse,
} from "./pipeline.js";
import {
  ApiResponseError,
  ApiUnreachableError,
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

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(pipelineRequest),
        signal: AbortSignal.timeout(1_200_000),
      });
    } catch (err) {
      // undici (Node fetch) wraps DNS/connect/TLS failures as
      // `TypeError("fetch failed")` with the system error attached as `cause`.
      // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError".
      const code = extractNetworkErrorCode(err);
      throw new ApiUnreachableError(
        `Could not reach Pipelex API at ${this.apiBaseUrl} (${code ?? "network error"})`,
        this.apiBaseUrl,
        code,
        { cause: err },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const { errorType, serverMessage } = parseErrorBody(body);
      throw new ApiResponseError(
        `API POST /${endpoint} failed (${response.status}): ${serverMessage ?? (body || response.statusText)}`,
        this.apiBaseUrl,
        response.status,
        response.statusText,
        body,
        errorType,
        serverMessage,
      );
    }

    return response.json();
  }

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    if (!options.pipe_code && (!options.mthds_contents || options.mthds_contents.length === 0)) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_contents must be provided to executePipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
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
    if (!options.pipe_code && (!options.mthds_contents || options.mthds_contents.length === 0)) {
      throw new PipelineRequestError(
        "Either pipe_code or mthds_contents must be provided to startPipeline."
      );
    }

    const request: PipelineRequest = {
      pipe_code: options.pipe_code,
      mthds_contents: options.mthds_contents,
      inputs: options.inputs,
      output_name: options.output_name,
      output_multiplicity: options.output_multiplicity,
      dynamic_output_concept_code: options.dynamic_output_concept_code,
    };

    const data = await this.makeApiCall("api/v1/pipeline/start", request);
    return data as PipelineStartResponse;
  }
}

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "ABORT_TIMEOUT";
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

/**
 * Pipelex API serializes errors as `{"detail": {"error_type": ..., "message": ...}}`
 * (HTTPException with dict detail) or `{"detail": "..."}` (auth 401s).
 * Both shapes are extracted here. Falls through silently on non-JSON bodies.
 */
function parseErrorBody(body: string): { errorType: string | undefined; serverMessage: string | undefined } {
  if (!body) return { errorType: undefined, serverMessage: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errorType: undefined, serverMessage: undefined };
  }
  if (!parsed || typeof parsed !== "object") {
    return { errorType: undefined, serverMessage: undefined };
  }
  const root = parsed as Record<string, unknown>;
  const detail = root.detail;
  let errorType: string | undefined;
  let serverMessage: string | undefined;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.error_type === "string") errorType = d.error_type;
    if (typeof d.message === "string") serverMessage = d.message;
  } else if (typeof detail === "string") {
    serverMessage = detail;
  }
  if (errorType === undefined && typeof root.error_type === "string") errorType = root.error_type;
  if (serverMessage === undefined && typeof root.message === "string") serverMessage = root.message;
  return { errorType, serverMessage };
}
