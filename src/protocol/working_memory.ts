/**
 * Working-memory domain shape — exact mirror of `mthds/protocol/working_memory.py`
 * (`WorkingMemoryAbstract`). The Dict-serialized concrete (`DictWorkingMemory`)
 * is runner-side (`runners/api/models.ts`).
 */

import type { StuffAbstract } from "./stuff.js";

export interface WorkingMemoryAbstract<TStuff extends StuffAbstract = StuffAbstract> {
  root: Record<string, TStuff>;
  aliases: Record<string, string>;
}
