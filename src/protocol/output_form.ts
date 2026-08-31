/**
 * Output-form descriptor — exact mirror of `mthds/protocol/output_form.py`.
 *
 * Normative page: "Output-Form Descriptor"
 * (`mthds/docs/spec/output-form-descriptor.md`). The presentation view of what
 * a pipe RESOLVES TO, and the exact twin of `input_form` for the other half of
 * the contract. Where the input-form descriptor states, in authored order, what
 * each declared input slot is, this states what the single output is — its
 * kind, its nesting, its constraints — so that rendering a result, registering
 * a tool signature with a return type, or projecting a typed structure for it
 * needs no schema heuristics and no guessing at a payload's shape.
 *
 * ## An output is a concept ref exactly like an input is
 *
 * That is the whole design, and it is why this module declares almost nothing
 * of its own. The same concepts, the same structures, the same field kinds, the
 * same nesting — so the same node vocabulary: `field` is an `InputFormField`,
 * imported verbatim from `./input_form.ts`. There is no parallel node union, no
 * second `kind` vocabulary, and therefore no second place for kinds to drift.
 *
 * What differs is only the SLOT facts, and there are three:
 *
 *   - **`name`.** An input's name is authored by the method; an output has none
 *     to author. The node still carries one because `InputFormField` is
 *     `InputFormItem & { name: string }` — the named half of the pair, where the
 *     nameless half is what a list's `item` holds. A producer states `"output"`.
 *     Nothing displays it: a result is labelled by its concept and a list entry
 *     by its index, exactly as the input-form page already rules for list items.
 *     It is an address, not a label.
 *   - **`presence`.** Three-valued on an input slot; an output has no marker —
 *     `!` MUST NOT appear on one, and `?` is stated by the contract's
 *     `optional`.
 *   - **`gating`.** Whether the run waits for the slot. Meaningless for a
 *     result.
 *
 * The last two are absent from an output node, which is expressed here the way
 * the rest of this package expresses "does not apply": the node type simply
 * never carries them, and `InputFormTopLevelField` — the layer that adds them —
 * is not used. `mthds-python` enforces the same absence at the parse.
 *
 * ## One `field`, not a `fields` list
 *
 * The one shape difference from `PipeInputFormDescriptor`, and it follows from
 * the language rather than from taste: a pipe has exactly one output where it
 * may have many inputs. A list of one would invite a consumer to loop and a
 * producer to wonder what a second entry means.
 *
 * ## Plurality is on the DESCRIPTOR, never on the concept
 *
 * `concept_ref` is the element with any multiplicity suffix stripped, on both
 * sides of the contract — a `Concept[]` output names `Concept`. So a plural
 * output is a `list` node whose `item` is the element, exactly as a plural
 * input's descriptor is, and a producer performs that wrap from the contract's
 * `multiplicity`: the concept alone cannot state it. A consumer never sees the
 * wrap — it reads `kind: "list"` and never touches the contract for plurality.
 *
 * ## Read with the contract, never instead of it
 *
 * The descriptor states what the field IS;
 * `PipeIOContract["output"]["json_schema"]` states the shape of the payload it
 * arrives in and names the property that payload sits under. Neither is
 * sufficient alone, which is why the two landed in the same version of the
 * standard.
 *
 * Types only. Closed shapes, on the same policy as every artifact here: a
 * member this version does not define is version drift.
 */

import type { InputFormField } from "./input_form.js";

/**
 * The output form of one pipe — one entry of `OutputForm`, carrying the single
 * output node. The node is an `InputFormField`, so a consumer narrows it on
 * `kind` with the same exhaustiveness guard it uses for an input node, and
 * `FIELD_KINDS` covers this artifact too. Closed shape.
 */
export interface PipeOutputFormDescriptor {
  /**
   * What the pipe resolves to, described. A `list` node on a plural output,
   * whose `item` is the element; the element concept is named by `concept_ref`
   * on both, multiplicity suffix stripped.
   */
  field: InputFormField;
}

/**
 * The artifact: fully-qualified `pipe_ref` (`domain_path.pipe_code`) →
 * descriptor, over the same key set as `PipeIOContracts` and `InputForm`.
 * Every pipe in the resolved library has an entry, contract-only pipe
 * signatures included.
 */
export type OutputForm = Record<string, PipeOutputFormDescriptor>;
