/**
 * Pipeline input value shapes — exact mirror of `mthds/protocol/pipeline_inputs.py`
 * (`StuffContentOrData`, `PipelineInputs`). The abstract input shapes only; the
 * Dict-serialized concrete (`DictStuff`) is runner-side (`runners/api/models.ts`).
 */

import type { StuffContentAbstract } from "./stuff.js";

// StuffContentOrData represents all possible formats for a pipeline input value:
// Case 1: Direct content (no 'concept' key)
//   - 1.1: string (simple string)
//   - 1.2: string[] (list of strings)
//   - 1.3: StuffContent (a StuffContent object)
//   - 1.4: StuffContent[] (list of StuffContent objects)
// Case 2: Dict with 'concept' AND 'content' keys
//   - 2.x: { concept: string, content: unknown } — a plain object (the
//     dict-serialized `DictStuff` form lives runner-side, in `runners/api/models.ts`).
export type StuffContentOrData =
  | string
  | string[]
  | StuffContentAbstract
  | StuffContentAbstract[]
  | Record<string, unknown>;

export type PipelineInputs = Record<string, StuffContentOrData>;
