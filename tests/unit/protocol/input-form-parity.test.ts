import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type { InputFormField, InputFormItem } from "../../../src/protocol/input_form.js";
import type { IOMultiplicity, PresenceMarker } from "../../../src/protocol/pipe_io_contracts.js";
import { INPUT_FORM_FIXTURE } from "../../fixtures/protocol/input_form.fixture.js";
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
 * The `it.fails` cases pin the known engine drift the README lists: they are
 * expected to fail against this fixture, and they flip to a failure of their
 * own the day a regenerated fixture conforms — the cue to delete them.
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

describe("protocol parity fixtures — twins", () => {
  it("the input_form twin is its JSON, value for value", () => {
    expect(INPUT_FORM_FIXTURE).toEqual(readFixture("input_form.json"));
  });

  it("the pipe_io_contracts twin is its JSON, value for value", () => {
    expect(PIPE_IO_CONTRACTS_FIXTURE).toEqual(readFixture("pipe_io_contracts.json"));
  });
});

describe("protocol parity fixtures — the pages' cross-artifact rules", () => {
  it("both artifacts are keyed by the same pipe_ref set", () => {
    expect(Object.keys(INPUT_FORM_FIXTURE).sort()).toEqual(
      Object.keys(PIPE_IO_CONTRACTS_FIXTURE).sort(),
    );
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
      const fields: InputFormField[] = descriptor.fields;
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
});

describe("protocol parity fixtures — known engine drift (see the README)", () => {
  it.fails("L-260826-0ed8dd: a list's item carries no name member", () => {
    for (const node of allNodes()) {
      if (node.kind === "list") expect("name" in node.item).toBe(false);
    }
  });

  it.fails("L-260826-236839: native.Date and native.Html slots are object nodes", () => {
    const fields = INPUT_FORM_FIXTURE["input_semantics_probe.probe_native_inputs"].fields;
    for (const field of fields) {
      if (field.concept_ref === "native.Date" || field.concept_ref === "native.Html") {
        expect(field.kind).toBe("object");
      }
    }
  });
});
