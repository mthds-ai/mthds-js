import { describe, expect, it } from "vitest";
import type {
  InputFormField,
  InputFormTopLevelField,
  PipeInputFormDescriptor,
} from "../../../src/protocol/input_form.js";
import type { InputsTemplateFormat } from "../../../src/protocol/inputs_template.js";
import {
  InputsTemplateError,
  formatSlotSignature,
  keepsEnvelope,
  projectInputsTemplate,
  renderInputsTemplate,
} from "../../../src/protocol/inputs_template.js";

/**
 * The projection's public entry point, on the ground the fixture corpus cannot
 * cover. Twin of `mthds-python`'s `tests/unit/test_inputs_template_rendering.py`.
 *
 * The corpus pins the bytes for every captured pipe, which is the deliverable;
 * what it cannot pin is the behaviour on a form the capture holds no example of —
 * a pipe that declares no inputs at all, a plural native slot — or the entry
 * point's own contract on the format it is asked for. Those are stated here,
 * along with the one mechanism this side has that the Python twin does not: the
 * decimal point a float placeholder keeps in both serializations.
 */

const EMPTY_DESCRIPTOR: PipeInputFormDescriptor = { fields: [] };

/** A `native.Date` payload: a required date beside the optional time that makes it an object. */
const DATE_PAYLOAD: InputFormField[] = [
  { name: "date", kind: "date", required: true, datetime: false },
  { name: "time", kind: "text", required: false, format: "time" },
];

interface SignatureCase {
  topic: string;
  field: InputFormTopLevelField;
  expected: string;
}

const SIGNATURES: SignatureCase[] = [
  {
    topic: "an unmarked single slot is its bare concept reference",
    field: {
      name: "note",
      kind: "text",
      concept_ref: "native.Text",
      required: true,
      presence: "plain",
      gating: true,
    },
    expected: "native.Text",
  },
  {
    topic:
      "the force assertion is kept, not flattened into the plain marker it requires the same of",
    field: {
      name: "forced",
      kind: "text",
      concept_ref: "native.Text",
      required: true,
      presence: "force",
      gating: true,
    },
    expected: "native.Text!",
  },
  {
    topic: "an optional slot carries its marker, and never gates",
    field: {
      name: "maybe",
      kind: "text",
      concept_ref: "native.Text",
      required: false,
      presence: "optional",
      gating: false,
    },
    expected: "native.Text?",
  },
  {
    topic: "a variable-length list takes empty brackets — the element concept is what is named",
    field: {
      name: "many",
      kind: "list",
      concept_ref: "input_semantics.Thing",
      required: true,
      presence: "plain",
      gating: false,
      item: { kind: "text", concept_ref: "input_semantics.Thing", required: true },
    },
    expected: "input_semantics.Thing[]",
  },
  {
    topic: "a fixed-count list states its count, which is the count the projection renders",
    field: {
      name: "two",
      kind: "list",
      concept_ref: "input_semantics.Thing",
      required: true,
      presence: "plain",
      gating: true,
      item: { kind: "text", concept_ref: "input_semantics.Thing", required: true },
      item_count: 2,
    },
    expected: "input_semantics.Thing[2]",
  },
];

interface EnvelopeCase {
  topic: string;
  field: InputFormTopLevelField;
  expected: boolean;
}

const ENVELOPE_RETENTION: EnvelopeCase[] = [
  {
    topic:
      "a single object-shaped native keeps its envelope: a bare date object is not re-shapable",
    field: {
      name: "date_in",
      kind: "object",
      concept_ref: "native.Date",
      required: true,
      presence: "plain",
      gating: true,
      fields: DATE_PAYLOAD,
    },
    expected: true,
  },
  {
    topic:
      "a list of that same native keeps it too — the question is the element's, never the list's",
    field: {
      name: "dates_in",
      kind: "list",
      concept_ref: "native.Date",
      required: true,
      presence: "plain",
      gating: false,
      item: { kind: "object", concept_ref: "native.Date", required: true, fields: DATE_PAYLOAD },
    },
    expected: true,
  },
  {
    topic: "a list of an out-of-matrix native keeps it, exactly as the single does",
    field: {
      name: "htmls_in",
      kind: "list",
      concept_ref: "native.Html",
      required: true,
      presence: "plain",
      gating: false,
      item: {
        kind: "object",
        concept_ref: "native.Html",
        required: true,
        fields: [{ name: "inner_html", kind: "text", required: true }],
      },
    },
    expected: true,
  },
  {
    topic: "a list of a scalar native does not: a bare URL per element is what a shaper takes back",
    field: {
      name: "images_in",
      kind: "list",
      concept_ref: "native.Image",
      required: true,
      presence: "plain",
      gating: false,
      item: { kind: "image", concept_ref: "native.Image", required: true },
    },
    expected: false,
  },
  {
    topic: "a list over an authored concept does not: it names no native to be unbuildable as",
    field: {
      name: "gadgets_in",
      kind: "list",
      concept_ref: "probe.Gadget",
      required: true,
      presence: "plain",
      gating: false,
      item: {
        kind: "object",
        concept_ref: "probe.Gadget",
        required: true,
        fields: [{ name: "label", kind: "text", required: true }],
      },
    },
    expected: false,
  },
];

const FIXED_COUNT_SLOT: InputFormTopLevelField = {
  name: "two",
  kind: "list",
  concept_ref: "probe.Gadget",
  required: true,
  presence: "plain",
  gating: true,
  item_count: 2,
  item: {
    kind: "object",
    concept_ref: "probe.Gadget",
    required: true,
    fields: [{ name: "label", kind: "text", required: true }],
  },
};

/** A structure field typed `number` and nothing more — the float placeholder's own slot. */
const FLOAT_SLOT: InputFormTopLevelField = {
  name: "ratio",
  kind: "number",
  concept_ref: "probe.Ratio",
  required: true,
  presence: "plain",
  gating: true,
  integer: false,
};

const SHAPES: { explicit: boolean; label: string }[] = [
  { explicit: false, label: "compact" },
  { explicit: true, label: "explicit" },
];

describe("a pipe declaring no inputs", () => {
  for (const { explicit, label } of SHAPES) {
    it(`projects to an empty template in the ${label} shape`, () => {
      // An empty input form is a valid form, and the projection says so rather than refusing: the
      // reference engine's own renderer is the one that raises on a pipe with no inputs.
      expect(projectInputsTemplate(EMPTY_DESCRIPTOR, { explicit })).toEqual({});
      expect(renderInputsTemplate(EMPTY_DESCRIPTOR, { explicit, format: "json" })).toBe("{}");
      expect(renderInputsTemplate(EMPTY_DESCRIPTOR, { explicit, format: "toml" })).toBe("");
    });
  }
});

describe("the format the entry point is asked for", () => {
  it("refuses an unknown one rather than rendering an empty document", () => {
    // The alternative is a switch that falls through every arm and hands back `undefined`, which
    // reads downstream as a template with no content rather than as a caller error.
    expect(() =>
      renderInputsTemplate(EMPTY_DESCRIPTOR, {
        explicit: false,
        format: "yaml" as InputsTemplateFormat,
      }),
    ).toThrow(InputsTemplateError);
  });
});

describe("a slot signature", () => {
  for (const { topic, field, expected } of SIGNATURES) {
    it(topic, () => {
      // The `# concept: …` comment a compact TOML template carries is io-ref notation, and a client
      // projection has only the descriptor to rebuild it from: the concept reference, the `list`
      // node's own count, and the authored presence marker.
      expect(formatSlotSignature(field)).toBe(expected);
    });
  }
});

describe("whether a compact slot keeps its envelope", () => {
  for (const { topic, field, expected } of ENVELOPE_RETENTION) {
    it(topic, () => {
      // What a shaper is handed at a plural slot is one element at a time, so the envelope question
      // is the element's. The corpus captures no plural native slot at all, which is why the rule is
      // stated here: without it `native.Date[]` unwraps to a bare array of the very objects a single
      // `native.Date` keeps its envelope to avoid, and the template no longer runs.
      expect(keepsEnvelope(field)).toBe(expected);
      const compact = projectInputsTemplate({ fields: [field] }, { explicit: false });
      const slot = compact[field.name];
      const wrapped = typeof slot === "object" && slot !== null && "content" in slot;
      expect(wrapped).toBe(expected);
    });
  }
});

describe("each element of a fixed-count slot", () => {
  for (const { explicit, label } of SHAPES) {
    it(`is its own value in the ${label} shape`, () => {
      // A `Concept[N]` slot renders N elements that are identical in content, and a template is a
      // thing somebody fills IN: were they one repeated object, typing into the first entry of the
      // returned mapping would type into every other one.
      const template = projectInputsTemplate({ fields: [FIXED_COUNT_SLOT] }, { explicit });
      const slot = template[FIXED_COUNT_SLOT.name];
      const elements = (explicit ? (slot as Record<string, unknown>).content : slot) as Record<
        string,
        unknown
      >[];
      expect(elements[0]).toEqual(elements[1]);
      expect(elements[0]).not.toBe(elements[1]);
      elements[0].label = "filled in by the caller";
      expect(elements[1].label).not.toBe(elements[0].label);
    });
  }
});

describe("a float placeholder", () => {
  it("keeps its decimal point in both serializations", () => {
    // TypeScript has one number type, so `0` and `0.0` are the same value and `JSON.stringify`
    // spells both `0`. The corpus is bytes, and Python's `json.dumps` writes `0.0` — so the
    // projection carries the distinction itself and renders JSON through its own writer.
    const descriptor: PipeInputFormDescriptor = { fields: [FLOAT_SLOT] };
    expect(renderInputsTemplate(descriptor, { explicit: false, format: "json" })).toBe(
      '{\n  "ratio": 0.0\n}',
    );
    expect(renderInputsTemplate(descriptor, { explicit: false, format: "toml" })).toBe(
      "# concept: probe.Ratio\nratio = 0.0\n",
    );
  });
});
