/**
 * Input-form descriptor — exact mirror of `mthds/protocol/input_form.py`.
 *
 * Normative page: "Input-Form Descriptor"
 * (`mthds/docs/spec/input-form-descriptor.md`, published on mthds.ai with
 * MTHDS v0.9.0), with the `hints` slot's shape from "Intent Hints"
 * (`mthds/docs/spec/intent-hints.md`). The descriptor is the per-pipe,
 * **ordered** presentation view of a method's inputs: one field descriptor per
 * declared input slot, in authored order, each a recursive node discriminated
 * on `kind` that states every fact a renderer needs — concept identity, the
 * refinement chain, the authored presence marker, the gating fact, structured
 * multiplicity, defaults, constraints, intent hints — so that no schema
 * heuristics, hardcoded native-concept tables or description matching are ever
 * needed. It rides the validate response as the standard's **recommended
 * extension field** `input_form` (see `ValidationReport` in `./models.ts`),
 * keyed by the same `pipe_ref` set as `PipeIOContracts`.
 *
 * Types only, plus one runtime value: `FIELD_KINDS`, the closed kind vocabulary
 * as a `const` tuple from which the `FieldKind` union is derived — the same
 * shape as `MODEL_CATEGORIES` in `./models.ts`. It exists because a union is
 * erased at build while a consumer still needs the vocabulary at run time: a
 * renderer's exhaustiveness guard over `kind`, or the parity test that checks
 * every kind an engine emitted is one this version defines. There is no
 * runtime validator here on purpose — engines own their emission gates and are
 * pinned to these types.
 *
 * Conventions the page fixes and these types follow:
 *   - wire names are snake_case, verbatim;
 *   - a slot that does not apply to a node is **absent**, never `null` — so
 *     every conditional slot is an optional property, and applicable falsy
 *     values (`required: false`, `integer: false`) are stated;
 *   - `item_count` is present exactly on a fixed `[N]` list and absent
 *     otherwise — the deliberate opposite of the contract, which always carries
 *     it and puts `null` off the fixed arm;
 *   - every object is a **closed shape**: a producer MUST NOT emit a member
 *     this version of the standard does not define, a consumer MAY reject one,
 *     and an unrecognized member is version drift. The validate *report* stays
 *     extension-open; the artifact does not. The `hints` map is the sole
 *     exception, and in content rather than shape: it stays a flat
 *     string → string map, while unknown keys and unknown `intent` words inside
 *     it are carried through untouched, as the language's leniency rule
 *     requires.
 */

import type { PresenceMarker } from "./pipe_io_contracts.js";

/**
 * The closed `kind` vocabulary of this version of the standard, in the page's
 * order. `unknown` is the mandatory escape hatch: a producer that cannot map a
 * node honestly MUST report it rather than guess a kind, and a renderer then
 * falls back to raw entry against the contract's `json_schema`. A derivation is
 * total — every node gets a descriptor — and `unknown` is what makes totality
 * truthful.
 */
export const FIELD_KINDS = [
  "text",
  "prose",
  "date",
  "number",
  "boolean",
  "enum",
  "document",
  "image",
  "object",
  "list",
  "unknown",
] as const;

/** One of `FIELD_KINDS` — the discriminant of every field descriptor. */
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * A node's effective intent hints: a flat string → string map, the final
 * key-by-key merge the language defines — along the concept's refinement
 * chain, nearer declaration winning, then the site layer (a structure field's
 * or an input slot's own `hints`) over the concept layer — so a consumer reads
 * one map and walks nothing. Everything well-formed rides it, unknown keys and
 * unknown words included. This version of the standard defines one key,
 * `intent`, with the words `prose` and `label` (text-valued sites) and `rating`
 * and `quantity` (number-valued sites). An applicable word is an input to kind
 * assignment, never a second answer competing with it; hints are non-normative
 * and a renderer that ignores them stays correct.
 */
export type IntentHints = Record<string, string>;

/**
 * The slots every node carries whatever its kind — everything but the authored
 * identifier `name`, which a `list`'s `item` does not have (see `InputFormItem`
 * and `InputFormField`).
 */
interface InputFormNodeCommon {
  /**
   * Human label; a renderer falls back to `name`. A generated or internal type
   * name is not a title and is never reported as one.
   */
  title?: string;
  /**
   * The fully-qualified concept reference the node carries — present on every
   * top-level field and on every nested node that is concept-typed, absent on a
   * node typed by a bare field type (`text`, `integer`, …). On a `list` node it
   * names the ELEMENT concept (the authored reference with its multiplicity
   * suffix stripped, exactly as the contract reports it) and the `item` carries
   * the same value.
   */
  concept_ref?: string;
  /**
   * The concept's refinement chain, immediate parent first, walked to its end
   * (`["legal.BaseClause", "native.Text"]`, `["native.Document"]`). Absent when
   * the concept refines nothing — a description-only concept is `kind: "prose"`
   * and never gets a fabricated `native.Text` link. "Does this refine
   * `native.X`?" is a membership test on this list, never shape sniffing.
   */
  refines?: string[];
  /** Helper text, from the authored concept or field description. */
  description?: string;
  /**
   * On a top-level field: the caller must supply the slot, derived as
   * `presence !== "optional"`. On a nested field: the field must be present
   * within its concept's payload. The two levels are independent facts and
   * never interact. `required` drives layout — a required field always shows,
   * an optional one may collapse; whether the user must put content in before
   * the run may start is the separate `gating` fact.
   */
  required: boolean;
  /**
   * Top-level fields only: the authored presence marker of the pipe's input
   * slot, three-valued so `!` is not flattened away. Nested fields carry no
   * `presence` — presence is a pipe-slot fact.
   */
  presence?: PresenceMarker;
  /**
   * Top-level fields only: the run cannot start until the caller provides
   * content for this slot; a nested field gates through its parent. Stated
   * rather than left to a consumer to re-derive, because it is not `required`:
   * the rule is `presence !== "optional"` and not (`kind === "list"` without
   * `item_count`) — a variable list is required, yet `[]` satisfies it, so it
   * never gates; a fixed `[N]` list does.
   */
  gating?: boolean;
  /**
   * The value applied when the caller omits the field. Present only when a
   * default was authored — the `null` a schema projection attaches to every
   * optional field is an emission artifact and is never reported here. Never
   * beside `required: true`: a defaulted field always reports `required: false`.
   */
  default_value?: unknown;
  /**
   * Example values for the field. Shaped now and authored by the language
   * later; a producer that has nothing to put here omits it.
   */
  examples?: unknown[];
  /**
   * The node's effective intent hints. Absent when the node has no effective
   * hints, so a hint-free method's descriptor is byte-identical to what it was
   * before hints existed. On a plural node the same map appears on the `list`
   * node and on its `item`, mirroring the `concept_ref` duplication.
   */
  hints?: IntentHints;
}

/**
 * The constraint slots the two text kinds share — stated where a producer
 * holds them, shaped now and authored by the language later.
 */
interface TextConstraintSlots {
  min_length?: number;
  max_length?: number;
  pattern?: string;
  /**
   * An open string set carrying schema formats the `date` kind does not absorb
   * (`"time"`, `"uri"`, …). `native.Time` and a `type = "time"` structure field
   * are `kind: "text"` with `format: "time"`.
   */
  format?: string;
}

/** A short single-line string. */
export interface TextFieldNode extends InputFormNodeCommon, TextConstraintSlots {
  kind: "text";
}

/**
 * Flowing free text — `native.Text`, a concept that resolves to no structure
 * (a description-only concept, or one whose refinement chain reaches such a
 * concept), or a text-valued site whose effective `intent` is `prose`.
 */
export interface ProseFieldNode extends InputFormNodeCommon, TextConstraintSlots {
  kind: "prose";
}

/** A calendar date, or a point in time. */
export interface DateFieldNode extends InputFormNodeCommon {
  kind: "date";
  /** Required: `true` when the value carries a time of day, `false` for a bare calendar date. */
  datetime: boolean;
}

/** An integer or a floating-point number. */
export interface NumberFieldNode extends InputFormNodeCommon {
  kind: "number";
  /** Required: `true` for an integer-valued field, `false` otherwise (`native.Number` is `false`). */
  integer: boolean;
  minimum?: number;
  maximum?: number;
  exclusive_minimum?: number;
  exclusive_maximum?: number;
}

/** True or false. */
export interface BooleanFieldNode extends InputFormNodeCommon {
  kind: "boolean";
}

/** One of a fixed set of values. */
export interface EnumFieldNode extends InputFormNodeCommon {
  kind: "enum";
  /**
   * Required, and always a list even for a single choice, so that no consumer
   * has to read a single-value form. The authored `choices`, verbatim.
   */
  choices: unknown[];
}

/**
 * A document supplied as a file or a URL. No accept-list and no upload
 * affordance: what the value is rides `concept_ref` and `refines`, and how a
 * renderer offers a file is the renderer's decision.
 */
export interface DocumentFieldNode extends InputFormNodeCommon {
  kind: "document";
}

/** An image, which a renderer may preview. */
export interface ImageFieldNode extends InputFormNodeCommon {
  kind: "image";
}

/** A structured concept. */
export interface ObjectFieldNode extends InputFormNodeCommon {
  kind: "object";
  /** Required: the concept's resolved payload fields, in declared order. */
  fields: InputFormField[];
}

/** An array of one element type. */
export interface ListFieldNode extends InputFormNodeCommon {
  kind: "list";
  /**
   * Required: the element descriptor, what a renderer renders once per entry.
   * It carries no `name` — the index labels items. A list whose element type
   * cannot be expressed (a list of lists, a list of dicts, a field with no
   * `item_type`) is still a `list` node — the plurality is stated — with an
   * `item` of `kind: "unknown"`.
   */
  item: InputFormItem;
  /**
   * Present exactly on a fixed `[N]` slot, where `N` is always at least 2
   * (`Concept[1]` is single, with no list framing). Absent — never `null` — on
   * a variable list and on every nested list field.
   */
  item_count?: number;
}

/** Not honestly describable as any other kind — the mandatory escape hatch. */
export interface UnknownFieldNode extends InputFormNodeCommon {
  kind: "unknown";
}

/**
 * A field descriptor without its authored identifier — the shape a `list`'s
 * `item` carries. The page's rule: an item has no authored name and carries no
 * `name` member at all, because the index labels items and a sentinel would be
 * a value two producers could pick differently. Every other node is an
 * `InputFormField`.
 */
export type InputFormItem =
  | TextFieldNode
  | ProseFieldNode
  | DateFieldNode
  | NumberFieldNode
  | BooleanFieldNode
  | EnumFieldNode
  | DocumentFieldNode
  | ImageFieldNode
  | ObjectFieldNode
  | ListFieldNode
  | UnknownFieldNode;

/**
 * One field descriptor: a recursive node discriminated on `kind`, carrying the
 * identifier as authored — the input slot name on a top-level field, the
 * structure field name on a nested one. An `object` node recurses through
 * `fields` (more `InputFormField`s), a `list` node through `item` (an
 * `InputFormItem`: this same shape minus `name`).
 */
export type InputFormField = InputFormItem & { name: string };

/**
 * The input form of one pipe — one entry of `InputForm`. `fields` holds one
 * descriptor per declared input slot, **in authored input order** — the order
 * the contract's `inputs` map deliberately does not carry, and the reason the
 * descriptor is a sibling artifact rather than a decoration inside each
 * contract entry. A pipe with no inputs maps to `{ fields: [] }`: an empty
 * form is a valid form, not an omitted entry. Closed shape.
 */
export interface PipeInputFormDescriptor {
  fields: InputFormField[];
}

/**
 * The artifact: fully-qualified `pipe_ref` (`domain_path.pipe_code`) →
 * descriptor, over the same key set as `PipeIOContracts`.
 */
export type InputForm = Record<string, PipeInputFormDescriptor>;
