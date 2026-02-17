import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineStartResponse,
} from "./pipeline.js";

export interface RunnerProtocol {
  executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse>;

  startPipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse>;
}
