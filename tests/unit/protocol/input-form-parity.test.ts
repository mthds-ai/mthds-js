import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type { InputFormItem, InputFormTopLevelField } from "../../../src/protocol/input_form.js";
import type { IOMultiplicity, PresenceMarker } from "../../../src/protocol/pipe_io_contracts.js";
import { INPUT_FORM_FIXTURE } from "../../fixtures/protocol/input_form.fixture.js";
import { OUTPUT_FORM_FIXTURE } from "../../fixtures/protocol/output_form.fixture.js";
import { PIPE_IO_CONTRACTS_FIXTURE } from "../../fixtures/protocol/pipe_io_contracts.fixture.js";

/**
 * Runtime half of the protocol parity check (the compile-time half is the
 * type each generated twin is declared with — see tests/fixtures/protocol/README.md).
 *
 * Two jobs. First, keep the twins honest: each must deep-equal the JSON it was
 * generated from, so a fixture replaced without `npm run fixtures:protocol`
 * fails here instead of silently type-checking a stale payload. Second, assert
 * the cross-artifact rules the pages state and a type cannot express — the
 * shared `pipe_ref` key set, the closed vocabularies, and the way `presence`,
 * `required`, `gating`, `multiplicity` and `item_count` line up between the
 * contract and the descriptor of the same slot.
 *
 * There is no drift block: the capture this fixture holds conforms to the pages
 * at every site it reaches. The rules that used to be pinned here as expected
 * failures are now ordinary assertions among the rest — a rule the engine got
 * right is worth asserting for the same reason it was worth pinning wrong.
 */

const PRESENCE_MARKERS: readonly PresenceMarker[] = ["plain", "optional", "force"];
const IO_MULTIPLICITIES: readonly IOMultiplicity[] = ["single", "variable", "fixed"];

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/protocol/${name}`, import.meta.url), "utf-8"),
  );
}

/** Every node of a descriptor tree, top-level fields first, then depth-first. */
function* walkNodes(node: InputFormItem): Generator<InputFormItem> {
  yield node;
  if (node.kind === "object") {
    for (const field of node.fields) yield* walkNodes(field);
  } else if (node.kind === "list") {
    yield* walkNodes(node.item);
  }
}

function* allNodes(): Generator<InputFormItem> {
  for (const descriptor of Object.values(INPUT_FORM_FIXTURE)) {
    for (const field of descriptor.fields) yield* walkNodes(field);
  }
}

/**
 * Every node paired with whether it sits in a `list`'s `item` position — the
 * one position the page says carries no `name`. Tracked here rather than read
 * off the node itself because the distinction is structural: an item node and
 * a named field node are otherwise the same shape.
 */
function* walkPositioned(
  node: InputFormItem,
  isItem: boolean,
): Generator<{ node: InputFormItem; isItem: boolean }> {
  yield { node, isItem };
  if (node.kind === "object") {
    for (const field of node.fields) yield* walkPositioned(field, false);
  } else if (node.kind === "list") {
    yield* walkPositioned(node.item, true);
  }
}

function* allPositionedNodes(): Generator<{ node: InputFormItem; isItem: boolean }> {
  for (const descriptor of Object.values(INPUT_FORM_FIXTURE)) {
    for (const field of descriptor.fields) yield* walkPositioned(field, false);
  }
}

describe("protocol parity fixtures — twins", () => {
  it("the input_form twin is its JSON, value for value", () => {
    expect(INPUT_FORM_FIXTURE).toEqual(readFixture("input_form.json"));
  });

  it("the output_form twin is its JSON, value for value", () => {
    expect(OUTPUT_FORM_FIXTURE).toEqual(readFixture("output_form.json"));
  });

  it("the pipe_io_contracts twin is its JSON, value for value", () => {
    expect(PIPE_IO_CONTRACTS_FIXTURE).toEqual(readFixture("pipe_io_contracts.json"));
  });
});

describe("protocol parity fixtures — the pages' cross-artifact rules", () => {
  it("all three artifacts are keyed by the same pipe_ref set", () => {
    expect(Object.keys(INPUT_FORM_FIXTURE).sort()).toEqual(
      Object.keys(PIPE_IO_CONTRACTS_FIXTURE).sort(),
    );
    expect(Object.keys(OUTPUT_FORM_FIXTURE).sort()).toEqual(
      Object.keys(PIPE_IO_CONTRACTS_FIXTURE).sort(),
    );
  });

  it("every kind an output node states is one this version of the standard defines", () => {
    // The output form reuses the input form's node union, so the SAME closed
    // vocabulary covers it. That reuse is the artifact's whole design, and this
    // is what keeps it honest rather than merely intended.
    for (const descriptor of Object.values(OUTPUT_FORM_FIXTURE)) {
      for (const node of walkNodes(descriptor.field)) {
        expect(FIELD_KINDS).toContain(node.kind);
      }
    }
  });

  it("an output node states neither presence nor gating", () => {
    // Both are facts of an INPUT slot: `!` may not appear on an output, `?` is
    // what the contract's `optional` states, and nothing waits on a result. The
    // node type leaves them optional so a slotless node can exist at all — not
    // so a producer may fill them in with something plausible.
    for (const descriptor of Object.values(OUTPUT_FORM_FIXTURE)) {
      const node = descriptor.field as unknown as Record<string, unknown>;
      expect(node.presence).toBeUndefined();
      expect(node.gating).toBeUndefined();
    }
  });

  it("a plural output is described as a list, and a single one is not", () => {
    // THE producer obligation of this artifact, and the one that fails silently.
    // `concept_ref` is the element with the multiplicity suffix stripped on both
    // sides of the contract, so a producer that does not read `multiplicity`
    // describes one item where a run returns many — and every renderer then
    // shows one.
    for (const [pipeRef, descriptor] of Object.entries(OUTPUT_FORM_FIXTURE)) {
      const output = PIPE_IO_CONTRACTS_FIXTURE[pipeRef]!.output;
      if (output.multiplicity === "single") {
        expect(descriptor.field.kind, pipeRef).not.toBe("list");
      } else {
        expect(descriptor.field.kind, pipeRef).toBe("list");
      }
    }
  });

  it("a fixed-count output states the same count on the descriptor and the contract", () => {
    for (const [pipeRef, descriptor] of Object.entries(OUTPUT_FORM_FIXTURE)) {
      const output = PIPE_IO_CONTRACTS_FIXTURE[pipeRef]!.output;
      if (descriptor.field.kind !== "list") continue;
      expect(descriptor.field.item_count ?? null, pipeRef).toEqual(output.item_count);
    }
  });

  it("an output's payload schema is its content model, never a bare array", () => {
    // Where the output side departs from the input side, asserted rather than
    // only documented. An input's schema describes what a caller SENDS, so a
    // plural slot's is a bare array; an output's describes what COMES BACK,
    // which is a content model — an object — whatever the multiplicity.
    for (const [pipeRef, contract] of Object.entries(PIPE_IO_CONTRACTS_FIXTURE)) {
      const schema = contract.output.json_schema as { type?: unknown; properties?: unknown };
      expect(schema.type, pipeRef).toBe("object");
      expect(schema.properties, pipeRef).toBeTypeOf("object");
    }
  });

  it("a fixed-count output bounds its element array to that count", () => {
    for (const [pipeRef, contract] of Object.entries(PIPE_IO_CONTRACTS_FIXTURE)) {
      const output = contract.output;
      if (output.multiplicity !== "fixed") continue;
      const properties = (output.json_schema as { properties: Record<string, unknown> }).properties;
      const elements = Object.values(properties)[0] as { minItems?: number; maxItems?: number };
      expect(elements.minItems, pipeRef).toBe(output.item_count);
      expect(elements.maxItems, pipeRef).toBe(output.item_count);
    }
  });

  it("every kind the engine emitted is one this version of the standard defines", () => {
    for (const node of allNodes()) {
      expect(FIELD_KINDS).toContain(node.kind);
    }
  });

  it("presence and multiplicity stay inside their closed vocabularies", () => {
    for (const contract of Object.values(PIPE_IO_CONTRACTS_FIXTURE)) {
      for (const input of Object.values(contract.inputs)) {
        expect(PRESENCE_MARKERS).toContain(input.presence);
        expect(IO_MULTIPLICITIES).toContain(input.multiplicity);
      }
      expect(IO_MULTIPLICITIES).toContain(contract.output.multiplicity);
    }
  });

  it("the contract's item_count is on the wire, non-null exactly on the fixed arm", () => {
    for (const contract of Object.values(PIPE_IO_CONTRACTS_FIXTURE)) {
      for (const slot of [...Object.values(contract.inputs), contract.output]) {
        expect("item_count" in slot).toBe(true);
        expect(slot.item_count !== null).toBe(slot.multiplicity === "fixed");
      }
    }
  });

  it("each top-level field matches its slot's contract on order, concept, presence and plurality", () => {
    for (const [pipeRef, descriptor] of Object.entries(INPUT_FORM_FIXTURE)) {
      const inputs = PIPE_IO_CONTRACTS_FIXTURE[pipeRef].inputs;
      const fields: InputFormTopLevelField[] = descriptor.fields;
      expect(fields.map((field) => field.name)).toEqual(Object.keys(inputs));
      for (const field of fields) {
        const contract = inputs[field.name];
        expect(field.concept_ref).toBe(contract.concept_ref);
        expect(field.presence).toBe(contract.presence);
        expect(field.required).toBe(contract.presence !== "optional");
        if (contract.multiplicity === "single") {
          expect("item_count" in field).toBe(false);
        } else {
          expect(field.kind).toBe("list");
          if (field.kind !== "list") continue;
          expect(field.item.concept_ref).toBe(field.concept_ref);
          if (contract.multiplicity === "fixed") {
            expect(field.item_count).toBe(contract.item_count);
          } else {
            expect("item_count" in field).toBe(false);
          }
        }
        const variableList = field.kind === "list" && !("item_count" in field);
        expect(field.gating).toBe(contract.presence !== "optional" && !variableList);
      }
    }
  });

  it("presence and gating are top-level facts — no nested node carries them", () => {
    for (const descriptor of Object.values(INPUT_FORM_FIXTURE)) {
      for (const field of descriptor.fields) {
        for (const node of walkNodes(field)) {
          if (node === field) continue;
          expect("presence" in node).toBe(false);
          expect("gating" in node).toBe(false);
        }
      }
    }
  });

  it("item_count is a top-level fact — no nested list node carries it", () => {
    for (const descriptor of Object.values(INPUT_FORM_FIXTURE)) {
      for (const field of descriptor.fields) {
        for (const node of walkNodes(field)) {
          if (node === field) continue;
          if (node.kind === "list") expect("item_count" in node).toBe(false);
        }
      }
    }
  });

  it("a defaulted field always reports required: false", () => {
    for (const node of allNodes()) {
      if ("default_value" in node) expect(node.required).toBe(false);
    }
  });

  it("name is carried on every node except a list's item", () => {
    let items = 0;
    let named = 0;
    for (const { node, isItem } of allPositionedNodes()) {
      expect("name" in node).toBe(!isItem);
      if (isItem) items += 1;
      else named += 1;
    }
    // Both arms are exercised: a payload that happened to hold no list would
    // pass the assertion above without ever testing the rule it is here for.
    expect(items).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
  });

  it("a native concept with a pinned structure lands on the object arm, not a scalar", () => {
    const expectedFields: Record<string, string[]> = {
      "native.Date": ["date", "time"],
      "native.Html": ["inner_html", "css_class"],
    };
    const fields = INPUT_FORM_FIXTURE["input_semantics_probe.probe_native_inputs"].fields;
    for (const [conceptRef, names] of Object.entries(expectedFields)) {
      const field = fields.find((candidate) => candidate.concept_ref === conceptRef);
      expect(field).toBeDefined();
      if (!field) continue;
      expect(field.kind).toBe("object");
      if (field.kind !== "object") continue;
      expect(field.fields.map((nested) => nested.name)).toEqual(names);
    }
  });
});
