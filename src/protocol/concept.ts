/**
 * Concept domain shape — exact mirror of `mthds/protocol/concept.py`
 * (`ConceptAbstract`). The protocol-level abstract concept; runners deal in the
 * Dict-serialized `concept` ref string (`runners/api/models.ts`).
 */

export interface ConceptAbstract {
  code: string;
  domain_code: string;
  description: string;
  structure_class_name: string;
  refines?: string | null;
}

/** `{domain_code}.{code}` — python's `ConceptAbstract.concept_ref` derived property. */
export function conceptRef(concept: Pick<ConceptAbstract, "domain_code" | "code">): string {
  return `${concept.domain_code}.${concept.code}`;
}
