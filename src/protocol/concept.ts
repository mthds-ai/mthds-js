/**
 * Concept domain shape — exact mirror of `mthds/protocol/concept.py`
 * (`ConceptAbstract`): a concept as a stuff names it, a reference and nothing
 * more.
 *
 * The standard puts a concept's definition — its description, its structure,
 * what it refines, and anything an implementation attaches to it such as the
 * name of a runtime class — in the library the method loads, never beside a
 * stuff (the "Stuffs on the Wire" section of the CLI I/O contract,
 * `mthds/docs/spec/cli-io-contract.md`). A runtime that needs more of the
 * definition in memory declares it on its own extension of this interface.
 * Runners deal in the Dict-serialized `concept` ref string
 * (`runners/api/models.ts`).
 */

export interface ConceptAbstract {
  code: string;
  domain_code: string;
}

/**
 * `{domain_code}.{code}` — python's `ConceptAbstract.concept_ref` derived property.
 *
 * This is the crate key for a concept the method's own package declares and for
 * a native one. A concept a dependency contributes is keyed
 * `<package_address>::<domain>.<Code>`, and this shape holds no declaring package
 * address, so that form is an extension's to produce.
 */
export function conceptRef(concept: Pick<ConceptAbstract, "domain_code" | "code">): string {
  return `${concept.domain_code}.${concept.code}`;
}
