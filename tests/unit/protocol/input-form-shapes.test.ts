import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type {
  FieldKind,
  InputFormField,
  InputFormItem,
  ListFieldNode,
  NumberFieldNode,
} from "../../../src/protocol/input_form.js";
import type {
  PipeInputContract,
  PipeIOContract,
  PipeOutputContract,
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
/** The descriptor omits `item_count` off the fixed arm; the contract carries `null` there. */
export type DescriptorItemCountIsAbsentOrNumber = Expect<
  Equal<ListFieldNode["item_count"], number | undefined>
>;
export type ContractItemCountIsAlwaysOnTheWire = Expect<
  Equal<PipeInputContract["item_count"], number | null>
>;
export type NumberStatesInteger = Expect<Equal<NumberFieldNode["integer"], boolean>>;
export type OutputOptionalIsTwoValued = Expect<Equal<PipeOutputContract["optional"], boolean>>;

// ── Positive cases: what the pages' own examples look like ──────────────────

const fixedList: InputFormField = {
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

const objectWithEnum: InputFormField = {
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

const contractWithExtraMember: PipeIOContract = {
  inputs: {},
  output: {
    concept_ref: "x.Y",
    multiplicity: "single",
    item_count: null,
    optional: false,
    // @ts-expect-error closed shape: the output contract carries no schema
    json_schema: {},
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
  output: { concept_ref: "x.Y", multiplicity: "single", item_count: null, optional: false },
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
      unknownKind,
      unknownMember,
      itemWithName,
      numberWithoutInteger,
      dateWithoutDatetime,
    ];
    expect(cases.map((field) => field.name)).toHaveLength(cases.length);
    expect(Object.keys(contract.inputs)).toEqual(["clauses", "instructions"]);
    expect(contractWithExtraMember.output.optional).toBe(false);
    expect(contractWithFlattenedPresence.inputs.a.multiplicity).toBe("single");
  });
});
