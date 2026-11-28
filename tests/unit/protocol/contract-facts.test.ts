import { describe, expect, it } from "vitest";
import {
  AGGREGATES,
  CONTRACT_FORMATS,
  OPTION_TONES,
  type Aggregate,
  type ChoiceOption,
  type ContractFormat,
  type EnumFieldNode,
  type InputFormField,
  type InputFormTopLevelField,
  type NumberFieldNode,
  type OptionTone,
  type TextFieldNode,
} from "../../../src/protocol/input_form.js";
import type { PipeOutputFormDescriptor } from "../../../src/protocol/output_form.js";

/**
 * The contract-fact slots and choice options of MTHDS standard `9.2.0`
 * (`mthds/docs/spec/input-form-descriptor.md`, "Contract Facts on a Descriptor"
 * and "Choice Options on a Descriptor"), stated as literals declared with the
 * artifact types, as `input-form-shapes.test.ts` does: `npm run
 * typecheck:test` is the test for the type-level cases, and a
 * `@ts-expect-error` that stops being needed is a type that drifted from the
 * page. The literals stay one property per line, since a `@ts-expect-error`
 * suppresses the next line only.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type FormatIsTheClosedSet = Expect<
  Equal<NonNullable<TextFieldNode["format"]>, ContractFormat>
>;
export type AggregateIsSumOrAverage = Expect<
  Equal<NonNullable<NumberFieldNode["aggregate"]>, Aggregate>
>;
/** A unit is carried as written, so a unit a later version adds still type-checks. */
export type UnitIsAnOpenString = Expect<Equal<NonNullable<NumberFieldNode["unit"]>, string>>;
export type ChoicesAreStrings = Expect<Equal<EnumFieldNode["choices"], string[]>>;
export type OptionsAreChoiceOptions = Expect<
  Equal<NonNullable<EnumFieldNode["options"]>, ChoiceOption[]>
>;
export type ToneIsTheClosedSet = Expect<Equal<NonNullable<ChoiceOption["tone"]>, OptionTone>>;

// ── Positive cases: the page's own examples ─────────────────────────────────

/** The input slot `invoice` and the input slot `tolerance` of the page's example, as the descriptor reports them. */
const invoice: InputFormTopLevelField = {
  kind: "object",
  name: "invoice",
  concept_ref: "billing.Invoice",
  description: "An invoice to check",
  required: true,
  presence: "plain",
  gating: true,
  fields: [
    {
      kind: "number",
      name: "total",
      description: "The total due",
      required: false,
      integer: false,
      minimum: 0,
      unit: "EUR",
      aggregate: "sum",
    },
  ],
};

const tolerance: InputFormTopLevelField = {
  kind: "number",
  name: "tolerance",
  concept_ref: "native.Number",
  description: "How far the total may drift, in per cent",
  required: true,
  presence: "plain",
  gating: true,
  integer: false,
  minimum: 0,
  maximum: 10,
  unit: "percent",
  examples: [2],
};

/** The `verdict` field of the page's choice-options example. */
const verdict: InputFormField = {
  kind: "enum",
  name: "verdict",
  description: "What to do with the clause",
  required: true,
  choices: ["accept", "negotiate", "refuse"],
  options: [
    { value: "accept", label: "Accept", tone: "positive" },
    {
      value: "negotiate",
      label: "Negotiate",
      tone: "caution",
      description: "Acceptable once the wording changes",
    },
    { value: "refuse", label: "Refuse", tone: "negative" },
  ],
  hints: { part: "verdict" },
};

const contact: InputFormField = {
  kind: "text",
  name: "contact",
  required: true,
  format: "email",
  min_length: 3,
  max_length: 254,
  examples: ["ada@example.com"],
};

/** The output form carries the same facts on every node inside an output. */
const outputWithFacts: PipeOutputFormDescriptor = {
  field: {
    kind: "list",
    name: "output",
    concept_ref: "billing.Line",
    required: true,
    item: {
      kind: "object",
      concept_ref: "billing.Line",
      required: true,
      fields: [
        {
          kind: "number",
          name: "amount",
          required: true,
          integer: false,
          unit: "EUR",
          aggregate: "sum",
          hints: { part: "metric" },
        },
      ],
    },
  },
};

// ── Negative cases ──────────────────────────────────────────────────────────

const unknownFormat: InputFormField = {
  kind: "text",
  name: "phone",
  required: true,
  // @ts-expect-error `format` is the closed set: the language's formats and `time`
  format: "phone",
};

const unknownAggregate: InputFormField = {
  kind: "number",
  name: "rate",
  required: true,
  integer: false,
  // @ts-expect-error `median` is not an aggregate
  aggregate: "median",
};

const aggregateOnText: InputFormField = {
  kind: "text",
  name: "label",
  required: true,
  // @ts-expect-error `aggregate` belongs to a `number` node only
  aggregate: "sum",
};

const unitOnText: InputFormField = {
  kind: "text",
  name: "label",
  required: true,
  // @ts-expect-error `unit` belongs to a `number` node only
  unit: "EUR",
};

const optionsOnText: InputFormField = {
  kind: "text",
  name: "label",
  required: true,
  // @ts-expect-error `options` belongs to an `enum` node only
  options: [{ value: "a", label: "A" }],
};

const unknownTone: InputFormField = {
  kind: "enum",
  name: "status",
  required: true,
  choices: ["ok"],
  options: [
    {
      value: "ok",
      // @ts-expect-error a tone is one of four words, never a colour
      tone: "green",
    },
  ],
};

const optionWithUnknownMember: InputFormField = {
  kind: "enum",
  name: "status",
  required: true,
  choices: ["ok"],
  options: [
    {
      value: "ok",
      // @ts-expect-error closed shape: an option carries value, label, description and tone only
      icon: "check",
    },
  ],
};

const nonStringChoice: InputFormField = {
  kind: "enum",
  name: "stars",
  required: true,
  // @ts-expect-error `choices` is a list of strings
  choices: [1, 2, 3],
};

const emptyExamples: InputFormField = {
  kind: "text",
  name: "brief",
  required: true,
  // @ts-expect-error `examples` is non-empty when present
  examples: [],
};

const booleanExample: InputFormField = {
  kind: "boolean",
  name: "flag",
  required: true,
  // @ts-expect-error an example is a string or a number, never a boolean
  examples: [true],
};

describe("contract facts and choice options", () => {
  it("CONTRACT_FORMATS is the language's formats plus `time`", () => {
    expect(CONTRACT_FORMATS).toEqual([
      "email",
      "uri",
      "date-time",
      "uuid",
      "hostname",
      "ipv4",
      "ipv6",
      "time",
    ]);
  });

  it("AGGREGATES and OPTION_TONES are the language's closed sets", () => {
    expect(AGGREGATES).toEqual(["sum", "average"]);
    expect(OPTION_TONES).toEqual(["positive", "caution", "negative", "neutral"]);
  });

  it("the compile-time cases above are real values", () => {
    const fields: InputFormField[] = [
      invoice,
      tolerance,
      verdict,
      contact,
      unknownFormat,
      unknownAggregate,
      aggregateOnText,
      unitOnText,
      optionsOnText,
      unknownTone,
      optionWithUnknownMember,
      nonStringChoice,
      emptyExamples,
      booleanExample,
    ];
    expect(fields.map((field) => field.name)).toHaveLength(fields.length);
    expect(outputWithFacts.field.kind).toBe("list");
  });

  it("the page's options example lists one option per choice, in the same order", () => {
    if (verdict.kind !== "enum") throw new Error("verdict is an enum node");
    expect(verdict.options?.map((option) => option.value)).toEqual(verdict.choices);
  });
});
