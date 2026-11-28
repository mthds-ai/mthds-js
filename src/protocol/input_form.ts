/**
 * Input-form descriptor — exact mirror of `mthds/protocol/input_form.py`.
 *
 * Normative page: "Input-Form Descriptor"
 * (`mthds/docs/spec/input-form-descriptor.md`, MTHDS standard `9.2.0`), with
 * the `hints` slot's shape from "Intent Hints"
 * (`mthds/docs/spec/intent-hints.md`), whose words are named in
 * `./intent_hints.ts`. The descriptor is the per-pipe,
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
 * Types only, plus the closed vocabularies as runtime values: `FIELD_KINDS`,
 * `CONTRACT_FORMATS`, `AGGREGATES` and `OPTION_TONES`, each a `const` tuple from
 * which its union is derived — the same shape as `MODEL_CATEGORIES` in
 * `./models.ts`. They exist because a union is erased at build while a
 * consumer still needs the vocabulary at run time: a renderer's exhaustiveness
 * guard over `kind` or `tone`, or the parity test that checks every value an
 * engine emitted is one this version defines. There is no runtime validator
 * here on purpose — engines own their emission gates and are pinned to these
 * types.
 *
 * Contract facts (MTHDS standard `9.2.0`). The language authors the constraint
 * slots (the four numeric bounds, `min_length`, `max_length`, `pattern`,
 * `format`) and the description slots (`unit` and `aggregate` on a `number`
 * node, `examples` on every node) as contract facts, and a producer states
 * each one the method authors on the node of the site that declares it: a
 * field's on the field's node, a slot's on the top-level node, or on a plural
 * slot's `item` (the `list` node of a plural slot carries none). The types
 * state each slot's own shape; the relations between facts (contradictory
 * bounds, an example breaking a constraint) are the producer's validation of
 * the method, since the descriptor is a presentation view and no validator of
 * payloads. Two rules a type cannot state stay producer obligations, as the
 * gating derivation does below: a length is a non-negative integer, and an
 * `enum` node's `options` lists one `ChoiceOption` per value of `choices`, in
 * the same order, and appears only when at least one option carries a word.
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
 * The closed `format` set a text node may carry: the language's formats, each
 * the JSON Schema format of the same name, plus `time`. `time` is not a value
 * an author writes: the `time` field type and `native.Time` produce it, as a
 * `text` node with `format: "time"`. Since `9.2.0` a producer emits no other
 * value, so any other format, such as `phone`, is version drift.
 */
export const CONTRACT_FORMATS = [
  "email",
  "uri",
  "date-time",
  "uuid",
  "hostname",
  "ipv4",
  "ipv6",
  "time",
] as const;

/** One of `CONTRACT_FORMATS` — the `format` slot of a text node. */
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];

/**
 * How the values of a number-valued field combine across the records that
 * hold it. A consumer presenting several records together may show the sum or
 * the average a field declares, counted in the field's effective unit, and
 * never a total or an average of a field that declares no `aggregate`.
 */
export const AGGREGATES = ["sum", "average"] as const;

/** One of `AGGREGATES` — the `aggregate` slot of a `number` node. */
export type Aggregate = (typeof AGGREGATES)[number];

/**
 * How a choice option reads to a person, never a colour. A consumer maps a
 * tone to its own palette or icon, shows an option without one as `neutral`,
 * and never infers a tone from an option's value or label.
 */
export const OPTION_TONES = ["positive", "caution", "negative", "neutral"] as const;

/** One of `OPTION_TONES` — the `tone` of a `ChoiceOption`. */
export type OptionTone = (typeof OPTION_TONES)[number];

/**
 * One authored example, as the value itself in JSON: a string, a number, or an
 * ISO 8601 string for a date, a date-time or a time. Never a boolean, and never
 * a string standing for a number.
 */
export type ExampleValue = string | number;

/**
 * One option of an `enum` node's `options`: its value, and the words and tone
 * the method gives it. Closed shape; a word the option does not declare is
 * absent, never `null`, and a declared word is never empty. Only `value`
 * matters to a payload; the rest is presentation.
 */
export interface ChoiceOption {
  /**
   * The option's value exactly as `choices` lists it at the same position — any
   * string a `choices` list holds, the empty string included for a list written
   * before option tables existed.
   */
  value: string;
  /** The option's name for people, such as `Under watch` for the value `HIGH_RISK`. */
  label?: string;
  /** What choosing the option means. */
  description?: string;
  /** How the option reads to a person; absent reads as `neutral`. */
  tone?: OptionTone;
}

/**
 * A node's effective intent hints: a flat string → string map, the final
 * key-by-key merge the language defines — along the concept's refinement
 * chain, nearer declaration winning, then the site layer (a structure field's
 * or an input slot's own `hints`) over the concept layer — so a consumer reads
 * one map and walks nothing. Everything well-formed rides it, unknown keys and
 * unknown words included. This version of the standard defines three keys —
 * `intent`, `role` (on a top-level field) and `part` (on a nested field) — whose
 * words `./intent_hints.ts` names for a consumer reading a hint by name; nothing
 * checks a map against them, so a word from a later version still type-checks
 * as a string. Only a text-valued node's `intent` is an input to kind
 * assignment (`prose`, `code` and `question` yield `prose`; `label` and
 * `identifier` yield `text`), never a second answer competing with it; `role`
 * and `part` never change a kind. Hints are non-normative and a renderer that
 * ignores them stays correct.
 */
export type IntentHints = Record<string, string>;

/**
 * The slots every node carries whatever its kind — everything but the authored
 * identifier `name`, which a `list`'s `item` does not have (see `InputFormItem`
 * and `InputFormField`), and the two pipe-slot facts `presence` and `gating`,
 * which only a top-level field states (see `InputFormTopLevelField`).
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
  /**
   * Helper text: on a top-level field, the input slot's own `description` when
   * it declares one, and otherwise its concept's; on a nested field, the
   * field's description.
   */
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
   * The value applied when the caller omits the field. Present only when a
   * default was authored — the `null` a schema projection attaches to every
   * optional field is an emission artifact and is never reported here. Never
   * beside `required: true`: a defaulted field always reports `required: false`.
   */
  default_value?: unknown;
  /**
   * The site's authored `examples` contract fact, each as the value itself in
   * JSON. Non-empty when present. A description, never a constraint: no value
   * is invalid for being unlike them.
   */
  examples?: [ExampleValue, ...ExampleValue[]];
  /**
   * The node's effective intent hints. Absent when the node has no effective
   * hints, so a hint-free method's descriptor is byte-identical to what it was
   * before hints existed. On a plural node the same map appears on the `list`
   * node and on its `item`, mirroring the `concept_ref` duplication.
   */
  hints?: IntentHints;
}

/**
 * The constraint slots the two text kinds share: the site's contract facts, as
 * the method authors them.
 */
interface TextConstraintSlots {
  /** The fewest characters the value holds, counted in Unicode code points; a non-negative integer. */
  min_length?: number;
  /** The most characters the value holds, counted in Unicode code points; a non-negative integer. */
  max_length?: number;
  /**
   * A regular expression in the ECMA-262 dialect JSON Schema's `pattern` uses,
   * matching anywhere in the value unless anchored.
   */
  pattern?: string;
  /**
   * One of the language's formats, or `time`, which `native.Time` and a
   * `type = "time"` structure field produce as `kind: "text"`.
   */
  format?: ContractFormat;
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
  /**
   * The site's effective unit: the site's own `unit`, or else the unit of the
   * concept that types it — an ISO 4217 currency code such as `EUR`, `percent`,
   * or a unit of measure such as `kg`. A description: a consumer shows the
   * number in it and converts nothing. Carried as written, so that a unit a
   * later version of the standard adds still type-checks.
   */
  unit?: string;
  /**
   * How the field's values combine across records. Only a structure field
   * declares one: an input slot holds one value, never a column.
   */
  aggregate?: Aggregate;
}

/** True or false. */
export interface BooleanFieldNode extends InputFormNodeCommon {
  kind: "boolean";
}

/** One of a fixed set of values. */
export interface EnumFieldNode extends InputFormNodeCommon {
  kind: "enum";
  /**
   * The option values, in declared order. Required, and always a list even for
   * a single choice, so that no consumer has to read a single-value form. A
   * renderer reading `choices` alone stays correct.
   */
  choices: string[];
  /**
   * The words and tone of each option, present only when at least one option of
   * the site carries a `label`, a `description` or a `tone`: one `ChoiceOption`
   * per value of `choices`, in the same order. A node whose options carry no
   * words has no `options` member.
   */
  options?: ChoiceOption[];
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
 * A top-level field — the shape of a `PipeInputFormDescriptor.fields` entry,
 * and the only layer that carries the two pipe-slot facts. Both are required:
 * the page gives their applicability as "top-level fields only" and derives a
 * determinate value for every authorable slot form, so "absent" is never a
 * legitimate answer here. Neither appears on any nested shape — the same
 * structural mechanism that keeps `name` off a list's `item`.
 *
 * A union discriminated on `required`, so the page's derivations are the type
 * rather than prose beside it — the idiom of `PipeInputContract`:
 *   - a top-level `required` restates the marker, `presence !== "optional"`
 *     exactly as the page derives it, so `required: true` pairs only with
 *     `"plain"` or `"force"` (the `Exclude` keeps the arm tied to the marker
 *     vocabulary) and `required: false` only with `"optional"` —
 *     `mthds-python` rejects the same two literals at the parse
 *     (`validate_required_restates_presence`);
 *   - an optional slot never gates: the page's gating table derives
 *     `gating: false` for `Concept?` unconditionally, so the optional arm
 *     pins it.
 * The one derivation a type cannot state: on the required arm, `gating` is
 * `false` exactly when the slot is a variable list (`kind === "list"` without
 * `item_count`) — a variable list is required, yet `[]` satisfies it, so it
 * never gates; a fixed `[N]` list does. That half stays a producer
 * obligation, and is why `gating` is stated on the wire at all rather than
 * left to a consumer to re-derive.
 *
 * `presence` is the authored marker of the pipe's input slot, three-valued so
 * `!` is not flattened away; `gating` says the run cannot start until the
 * caller provides content for this slot (a nested field gates through its
 * parent). Nested fields carry neither — both are pipe-slot facts.
 */
export type InputFormTopLevelField = InputFormField &
  (
    | { required: true; presence: Exclude<PresenceMarker, "optional">; gating: boolean }
    | { required: false; presence: "optional"; gating: false }
  );

/**
 * The input form of one pipe — one entry of `InputForm`. `fields` holds one
 * descriptor per declared input slot, **in authored input order** — the order
 * the contract's `inputs` map deliberately does not carry, and the reason the
 * descriptor is a sibling artifact rather than a decoration inside each
 * contract entry. A pipe with no inputs maps to `{ fields: [] }`: an empty
 * form is a valid form, not an omitted entry. Closed shape.
 */
export interface PipeInputFormDescriptor {
  fields: InputFormTopLevelField[];
}

/**
 * The artifact: fully-qualified `pipe_ref` (`domain_path.pipe_code`) →
 * descriptor, over the same key set as `PipeIOContracts`.
 */
export type InputForm = Record<string, PipeInputFormDescriptor>;
