/**
 * Pipe-output domain shapes — exact mirror of `mthds/protocol/pipe_output.py`
 * (`VariableMultiplicity`, `PipeOutputAbstract`). The Dict-serialized concrete
 * (`DictPipeOutput`) is runner-side (`runners/api/models.ts`).
 */

import type { WorkingMemoryAbstract } from "./working_memory.js";

export type VariableMultiplicity = boolean | number;

export interface PipeOutputAbstract<
  TWorkingMemory extends WorkingMemoryAbstract = WorkingMemoryAbstract,
> {
  working_memory: TWorkingMemory;
  pipeline_run_id: string;
}
