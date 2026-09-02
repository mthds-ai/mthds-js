import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type {
  FieldKind,
  InputFormField,
  InputFormItem,
  InputFormTopLevelField,
  ListFieldNode,
  NumberFieldNode,
  PipeInputFormDescriptor,
} from "../../../src/protocol/input_form.js";
import type {
  IOMultiplicity,
  PipeInputContract,
  PipeIOContract,
  PipeOutputContract,
  PresenceMarker,
} from "../../../src/protocol/pipe_io_contracts.js";

/**
 * The page rules the types enforce at compile time, stated as tiny literals
 * declared with the artifact types (the same idiom the generated fixture twins
 * use). `npm run typecheck:test` is the test: a positive case that stops
 * compiling, or a `@ts-expect-error` that stops being needed, is a type that
 * drifted from `mthds/docs/spec/input-form-descriptor.md` /
 * `pipe-io-contracts.md`.
 *
 * The literals stay expanded one property per line on purpose — a
 * `@ts-expect-error` suppresses the next line only. An excess or ill-typed
 * property is reported on that property's line; a missing required slot is
 * reported on the declaration, so those directives sit above the `const`.
 */

// ── Type-level assertions (exported so `noUnusedLocals` keeps them) ──────────

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type KindUnionIsTheTuple = Expect<Equal<FieldKind, (typeof FIELD_KINDS)[number]>>;
/** A list's item is the field shape minus `name` — no member of the union carries one. */
export type ItemHasNoName = Expect<Equal<"name" extends keyof InputFormItem ? true : false, false>>;
export type FieldNameIsRequired = Expect<Equal<InputFormField["name"], string>>;
/** The pipe-slot facts are top-level only: no nested shape carries either. */
export type ItemHasNoPresence = Expect<
  Equal<"presence" extends keyof InputFormItem ? true : false, false>
>;
export type FieldHasNoGating = Expect<
  Equal<"gating" extends keyof InputFormField ? true : false, false>
>;
/** …and a top-level field states both (the `| undefined` an optional slot would add fails Equal). */
export type TopLevelPresenceIsRequired = Expect<
  Equal<InputFormTopLevelField["presence"], PresenceMarker>
>;
export type TopLevelGatingIsRequired = Expect<Equal<InputFormTopLevelField["gating"], boolean>>;
/** …and `required` restates the marker: presence != "optional", exactly as the page derives it… */
export type RequiredTopLevelIsNeverOptional = Expect<
  Equal<Extract<InputFormTopLevelField, { required: true }>["presence"], "plain" | "force">
>;
export type OptionalTopLevelIsNeverRequired = Expect<
  Equal<Extract<InputFormTopLevelField, { required: false }>["presence"], "optional">
>;
/** …while an optional slot never gates — the gating table's `Concept?` row. */
export type OptionalTopLevelNeverGates = Expect<
  Equal<Extract<InputFormTopLevelField, { required: false }>["gating"], false>
>;
export type DescriptorFieldsAreTopLevel = Expect<
  Equal<PipeInputFormDescriptor["fields"], InputFormTopLevelField[]>
>;
/** The descriptor omits `item_count` off the fixed arm; the contract carries `null` there. */
export type DescriptorItemCountIsAbsentOrNumber = Expect<
  Equal<ListFieldNode["item_count"], number | undefined>
>;
export type ContractItemCountIsAlwaysOnTheWire = Expect<
  Equal<PipeInputContract["item_count"], number | null>
>;
/** The contract unions discriminate on the full closed multiplicity vocabulary. */
export type InputContractCoversEveryMultiplicity = Expect<
  Equal<PipeInputContract["multiplicity"], IOMultiplicity>
>;
export type OutputContractCoversEveryMultiplicity = Expect<
  Equal<PipeOutputContract["multiplicity"], IOMultiplicity>
>;
/** The pairing rules the pages state, as narrowing: count non-`null` exactly on the fixed arm… */
export type FixedInputCountIsNumber = Expect<
  Equal<Extract<PipeInputContract, { multiplicity: "fixed" }>["item_count"], number>
>;
export type SingleInputCountIsNull = Expect<
  Equal<Extract<PipeInputContract, { multiplicity: "single" }>["item_count"], null>
>;
export type FixedOutputCountIsNumber = Expect<
  Equal<Extract<PipeOutputContract, { multiplicity: "fixed" }>["item_count"], number>
>;
/** …markers never combine with multiplicity: a plural input is plain, a plural output never optional. */
export type PluralInputPresenceIsPlain = Expect<
  Equal<Extract<PipeInputContract, { multiplicity: "variable" | "fixed" }>["presence"], "plain">
>;
export type PluralOutputIsNeverOptional = Expect<
  Equal<Extract<PipeOutputContract, { multiplicity: "variable" | "fixed" }>["optional"], false>
>;
export type NumberStatesInteger = Expect<Equal<NumberFieldNode["integer"], boolean>>;
export type OutputOptionalIsTwoValued = Expect<Equal<PipeOutputContract["optional"], boolean>>;

// ── Positive cases: what the pages' own examples look like ──────────────────

const fixedList: InputFormTopLevelField = {
  kind: "list",
  name: "clauses",
  concept_ref: "legal.Clause",
  refines: ["native.Text"],
  required: true,
  presence: "plain",
  gating: true,
  item: {
    kind: "prose",
    concept_ref: "legal.Clause",
    refines: ["native.Text"],
    required: true,
  },
  item_count: 3,
};

const objectWithEnum: InputFormTopLevelField = {
  kind: "object",
  name: "review",
  concept_ref: "demo.Review",
  required: false,
  presence: "optional",
  gating: false,
  hints: { intent: "prose", future_key: "carried through" },
  fields: [
    {
      kind: "enum",
      name: "tone",
      required: false,
      default_value: "casual",
      choices: ["formal", "casual"],
    },
    { kind: "number", name: "stars", required: true, integer: true, minimum: 1, maximum: 5 },
    { kind: "date", name: "posted_at", required: true, datetime: true },
    { kind: "text", name: "daily_at", required: true, format: "time" },
  ],
};

const forcedSingle: InputFormTopLevelField = {
  kind: "document",
  name: "signed_original",
  concept_ref: "native.Document",
  required: true,
  presence: "force",
  gating: true,
};

const contract: PipeIOContract = {
  inputs: {
    clauses: {
      concept_ref: "legal.Clause",
      presence: "plain",
      multiplicity: "fixed",
      item_count: 3,
      json_schema: { type: "array", items: { type: "object" }, minItems: 3, maxItems: 3 },
    },
    instructions: {
      concept_ref: "native.Text",
      presence: "optional",
      multiplicity: "single",
      item_count: null,
      json_schema: { type: "object" },
    },
  },
  output: {
    concept_ref: "legal.Summary",
    multiplicity: "single",
    item_count: null,
    optional: false,
    // The payload's schema — the concept's content model, not a caller's
    // argument. A structured concept IS its own content model, so nothing
    // wraps it; a plural output's would be the list envelope instead.
    json_schema: { type: "object" },
  },
};

// ── Negative cases: the closed shapes and the required per-kind slots ───────

const unknownKind: InputFormField = {
  // @ts-expect-error the kind union is closed
  kind: "widget",
  name: "w",
  required: true,
};

const unknownMember: InputFormField = {
  kind: "boolean",
  name: "flag",
  required: true,
  // @ts-expect-error closed shape: an unknown member is version drift
  widget: "checkbox",
};

const itemWithName: InputFormField = {
  kind: "list",
  name: "tags",
  required: true,
  item: {
    kind: "text",
    // @ts-expect-error a list's item carries no `name` member
    name: "tags",
    required: true,
  },
};

// @ts-expect-error a number node must state `integer`
const numberWithoutInteger: InputFormField = {
  kind: "number",
  name: "n",
  required: true,
};

// @ts-expect-error a date node must state `datetime`
const dateWithoutDatetime: InputFormField = {
  kind: "date",
  name: "d",
  required: true,
};

// @ts-expect-error a top-level field states both pipe-slot facts
const topLevelWithoutSlotFacts: InputFormTopLevelField = {
  kind: "boolean",
  name: "flag",
  required: true,
};

// The presence pairing, as the invalid literals mthds-python's validators reject.

// @ts-expect-error required restates the marker: an optional slot is never required
const topLevelOptionalYetRequired: InputFormTopLevelField = {
  kind: "text",
  name: "instructions",
  required: true,
  presence: "optional",
  gating: false,
};

// @ts-expect-error required restates the marker: a plain slot is always required
const topLevelPlainYetNotRequired: InputFormTopLevelField = {
  kind: "text",
  name: "brief",
  required: false,
  presence: "plain",
  gating: true,
};

// @ts-expect-error an optional slot never gates — the gating table's `Concept?` row
const topLevelOptionalYetGating: InputFormTopLevelField = {
  kind: "text",
  name: "notes",
  required: false,
  presence: "optional",
  gating: true,
};

const nestedWithPresence: InputFormField = {
  kind: "object",
  name: "review",
  required: true,
  fields: [
    {
      kind: "text",
      name: "headline",
      required: true,
      // @ts-expect-error presence is a pipe-slot fact, stated on top-level fields only
      presence: "plain",
    },
  ],
};

const contractWithExtraMember: PipeIOContract = {
  inputs: {},
  output: {
    concept_ref: "x.Y",
    multiplicity: "single",
    item_count: null,
    optional: false,
    json_schema: {},
    // @ts-expect-error closed shape: an output contract carries no presence —
    // `!` may not appear on an output, and `?` is what `optional` states.
    presence: "plain",
  },
};

const contractWithFlattenedPresence: PipeIOContract = {
  inputs: {
    a: {
      concept_ref: "x.Y",
      // @ts-expect-error presence is three-valued, never a boolean
      presence: true,
      multiplicity: "single",
      item_count: null,
      json_schema: {},
    },
  },
  output: {
    concept_ref: "x.Y",
    multiplicity: "single",
    item_count: null,
    optional: false,
    json_schema: {},
  },
};

// The pairing rules, as the invalid literals mthds-python's validators reject.

// @ts-expect-error the fixed arm states its exact count, never null
const inputFixedWithoutCount: PipeInputContract = {
  concept_ref: "x.Y",
  presence: "plain",
  multiplicity: "fixed",
  item_count: null,
  json_schema: {},
};

// @ts-expect-error item_count is null off the fixed arm — [1] is a way of writing Concept
const inputSingleWithCount: PipeInputContract = {
  concept_ref: "x.Y",
  presence: "plain",
  multiplicity: "single",
  item_count: 1,
  json_schema: {},
};

// @ts-expect-error markers may not combine with multiplicity: a plural slot is plain
const inputVariableOptional: PipeInputContract = {
  concept_ref: "x.Y",
  presence: "optional",
  multiplicity: "variable",
  item_count: null,
  json_schema: {},
};

// @ts-expect-error markers may not combine with multiplicity: a plural slot is plain
const inputFixedForced: PipeInputContract = {
  concept_ref: "x.Y",
  presence: "force",
  multiplicity: "fixed",
  item_count: 2,
  json_schema: {},
};

// @ts-expect-error the fixed arm states its exact count, never null
const outputFixedWithoutCount: PipeOutputContract = {
  concept_ref: "x.Y",
  multiplicity: "fixed",
  item_count: null,
  optional: false,
};

// @ts-expect-error a plural output is never optional — ? may not ride multiplicity
const outputFixedOptional: PipeOutputContract = {
  concept_ref: "x.Y",
  multiplicity: "fixed",
  item_count: 2,
  optional: true,
};

describe("input-form and contract shapes", () => {
  it("FIELD_KINDS is the page's closed vocabulary, in the page's order, without duplicates", () => {
    expect(FIELD_KINDS).toEqual([
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
    ]);
    expect(new Set(FIELD_KINDS).size).toBe(FIELD_KINDS.length);
  });

  it("the compile-time cases above are real values", () => {
    const cases = [
      fixedList,
      objectWithEnum,
      forcedSingle,
      unknownKind,
      unknownMember,
      itemWithName,
      numberWithoutInteger,
      dateWithoutDatetime,
      topLevelWithoutSlotFacts,
      topLevelOptionalYetRequired,
      topLevelPlainYetNotRequired,
      topLevelOptionalYetGating,
      nestedWithPresence,
    ];
    expect(cases.map((field) => field.name)).toHaveLength(cases.length);
    expect(Object.keys(contract.inputs)).toEqual(["clauses", "instructions"]);
    expect(contractWithExtraMember.output.optional).toBe(false);
    expect(contractWithFlattenedPresence.inputs.a.multiplicity).toBe("single");
    const invalidContractSlots = [
      inputFixedWithoutCount,
      inputSingleWithCount,
      inputVariableOptional,
      inputFixedForced,
      outputFixedWithoutCount,
      outputFixedOptional,
    ];
    expect(invalidContractSlots.map((slot) => slot.concept_ref)).toHaveLength(
      invalidContractSlots.length,
    );
  });
});
