import type { DictStuff } from "./stuff.js";

// StuffContentOrData represents all possible formats for pipeline inputs:
// Case 1: Direct content (no 'concept' key)
//   - 1.1: string (simple string)
//   - 1.2: string[] (list of strings)
// Case 2: Dict with 'concept' AND 'content' keys
//   - 2.1: { concept: string, content: unknown } (DictStuff shape)
//   - 2.2: Record<string, unknown> (plain object)
export type StuffContentOrData =
  | string
  | string[]
  | Record<string, unknown>
  | DictStuff;

export type PipelineInputs = Record<string, StuffContentOrData>;
