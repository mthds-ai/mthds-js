/**
 * Stuff domain shapes — exact mirror of `mthds/protocol/stuff.py`
 * (`StuffAbstract`, `StuffContentAbstract`). The protocol-level abstract stuff;
 * the Dict-serialized concrete (`DictStuff`) is runner-side
 * (`runners/api/models.ts`).
 */

import type { ConceptAbstract } from "./concept.js";

/** Marker base for a stuff's content payload (mirrors python `StuffContentAbstract`). */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface StuffContentAbstract {}

export interface StuffAbstract<
  TConcept extends ConceptAbstract = ConceptAbstract,
  TContent extends StuffContentAbstract = StuffContentAbstract,
> {
  stuff_code: string;
  stuff_name?: string | null;
  concept: TConcept;
  content: TContent;
}
