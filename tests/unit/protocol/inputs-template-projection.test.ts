import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type { InputForm, InputFormItem } from "../../../src/protocol/input_form.js";
import { renderInputsTemplate } from "../../../src/protocol/inputs_template.js";
import type { InputsTemplateFormat } from "../../../src/protocol/inputs_template.js";

/**
 * The shared projection fixture corpus, from this side of the mirror.
 *
 * A pipe's fill-in inputs template is projected client-side from the input-form
 * descriptor — once here, once in `mthds-python` — and the two projections must
 * produce the *same bytes*, TOML `# concept:` comment lines included, or the
 * JS/Python asymmetry the build-route retirement set out to remove is simply
 * rebuilt one layer up. `tests/fixtures/protocol/inputs_template/` holds the
 * expected bytes; `mthds-python` commits the identical tree and runs the twin of
 * this file. See tests/fixtures/protocol/README.md for the provenance.
 *
 * Five jobs:
 *
 *  1. **Byte parity** — every corpus file reproduced exactly by the projection
 *     in `src/protocol/inputs_template.ts`. It is the whole point of the corpus,
 *     and the reason the corpus landed before either projection was written.
 *  2. **Kind coverage** — the kinds the corpus exercises must be the *whole*
 *     closed vocabulary. A kind added to the standard without a fixture is a
 *     corpus gap, and this says so by name rather than passing silently.
 *  3. **File-set completeness** — every pipe the manifest names, in both shapes
 *     and both formats, non-empty.
 *  4. **Divergence lapse** — the corpus deliberately differs from the reference
 *     engine's own inputs-template renderer in declared places. Each declared
 *     class must still be visible in the committed bytes, so an engine fix
 *     retires its entry deliberately instead of leaving the manifest claiming a
 *     difference that has gone.
 *  5. **Unshapeable-record integrity** — the generator round-trips every template
 *     through the runtime's own input shaper and records each refusal. The
 *     verdict itself cannot be re-derived here (there is no shaper on this side
 *     of the mirror), so what this checks is that the record keys resolve against
 *     the rest of the manifest and each entry names the gap that retires it.
 */

const CORPUS_URL = new URL("../../fixtures/protocol/", import.meta.url);
const TEMPLATES_URL = new URL("inputs_template/", CORPUS_URL);

interface DivergenceExample {
  pipe_ref: string;
  shape: string;
  path: string;
  engine: unknown;
  expected: unknown;
}

interface DeclaredDivergence {
  divergence_id: string;
  reason: string;
  occurrences: number;
  examples: DivergenceExample[];
}

/**
 * One template the generator handed to `InputShaper.shape` and the runtime refused.
 *
 * A template's whole purpose is to be filled in and handed back, so the corpus states
 * outright which of its own pinned bytes the runtime will not accept today, and names
 * the ledger item whose fix retires the entry — at which point the corpus is
 * regenerated and the entry disappears on its own.
 */
interface UnshapeableEntry {
  pipe_ref: string;
  shape: string;
  error_type: string;
  ledger_item: string;
}

interface CorpusManifest {
  bundles: string[];
  pipes: string[];
  shapes: string[];
  formats: string[];
  divergences: DeclaredDivergence[];
  unshapeable: UnshapeableEntry[];
}

function readCorpusJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, CORPUS_URL), "utf-8")) as T;
}

const MANIFEST = readCorpusJson<CorpusManifest>("inputs_template/manifest.json");
const INPUT_FORM = readCorpusJson<InputForm>("input_form.json");

/** Every node of a descriptor tree, the top-level fields first, then depth-first. */
function* walkNodes(node: InputFormItem): Generator<InputFormItem> {
  yield node;
  if (node.kind === "object") {
    for (const field of node.fields) yield* walkNodes(field);
  } else if (node.kind === "list") {
    yield* walkNodes(node.item);
  }
}

/** The corpus file name for one pipe, shape and format — the layout is the contract. */
function templateFileName(pipeRef: string, shape: string, format: string): string {
  return `${pipeRef}.${shape}.${format}`;
}

function readTemplate(pipeRef: string, shape: string, format: string): string {
  return readFileSync(new URL(templateFileName(pipeRef, shape, format), TEMPLATES_URL), "utf-8");
}

/** One dotted path into a projected template — `"page_in.content.images.0"`. */
function valueAtPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

describe("the inputs-template corpus", () => {
  // The axes are read from the manifest but not trusted from it. Every case below is a product of
  // these two lists, so a regeneration that dropped a shape or a format would quietly shrink the
  // suite instead of failing it — the parity check would stop covering TOML and still report green.
  // Pinning them means the corpus can grow a pipe without touching this file, but never lose an axis.
  it("still holds both shapes and both formats", () => {
    expect([...MANIFEST.shapes].sort()).toEqual(["compact", "explicit"]);
    expect([...MANIFEST.formats].sort()).toEqual(["json", "toml"]);
  });

  it("exercises the whole closed kind vocabulary", () => {
    const covered = new Set<string>();
    for (const descriptor of Object.values(INPUT_FORM)) {
      for (const field of descriptor.fields) {
        for (const node of walkNodes(field)) covered.add(node.kind);
      }
    }
    // Equality both ways: a kind the corpus misses is a gap, and a kind it holds
    // that the vocabulary no longer declares is a stale capture.
    expect([...covered].sort()).toEqual([...FIELD_KINDS].sort());
  });

  it("holds every pipe in both shapes and both formats", () => {
    const expected = MANIFEST.pipes
      .flatMap((pipeRef) =>
        MANIFEST.shapes.flatMap((shape) =>
          MANIFEST.formats.map((format) => templateFileName(pipeRef, shape, format)),
        ),
      )
      .sort();
    const present = readdirSync(fileURLToPath(TEMPLATES_URL))
      .filter((name) => name !== "manifest.json")
      .sort();
    expect(present).toEqual(expected);
  });

  it("describes exactly the pipes the descriptor capture holds", () => {
    expect(MANIFEST.pipes.slice().sort()).toEqual(Object.keys(INPUT_FORM).sort());
  });

  it("has no empty template", () => {
    for (const pipeRef of MANIFEST.pipes) {
      for (const shape of MANIFEST.shapes) {
        for (const format of MANIFEST.formats) {
          expect(readTemplate(pipeRef, shape, format).trim()).not.toBe("");
        }
      }
    }
  });
});

describe("the declared divergences from the reference engine", () => {
  it("declares at least one", () => {
    expect(MANIFEST.divergences.length).toBeGreaterThan(0);
  });

  for (const divergence of MANIFEST.divergences) {
    describe(divergence.divergence_id, () => {
      it("states why it exists and where it occurs", () => {
        expect(divergence.reason).not.toBe("");
        expect(divergence.occurrences).toBeGreaterThan(0);
        expect(divergence.examples.length).toBeGreaterThan(0);
      });

      it("is still visible in the committed bytes", () => {
        for (const example of divergence.examples) {
          const template = JSON.parse(
            readTemplate(example.pipe_ref, example.shape, "json"),
          ) as unknown;
          // The corpus must hold what the manifest says it holds — and something
          // other than what the engine emitted, or the class has lapsed.
          expect(valueAtPath(template, example.path)).toEqual(example.expected);
          expect(example.expected).not.toEqual(example.engine);
        }
      });
    });
  }
});

describe("the unshapeable record", () => {
  // The generator hands every projected template to the runtime's own `InputShaper.shape`
  // and writes down each refusal, because a template nobody can fill in and hand back is
  // not a template. There is no shaper on this side of the mirror, so the verdict itself
  // is taken on the generator's authority; what is checkable here is that the record is
  // about *this* corpus and stays that way across a regeneration.
  it("keys every entry to a pipe and a shape the corpus holds", () => {
    for (const entry of MANIFEST.unshapeable) {
      expect(MANIFEST.pipes).toContain(entry.pipe_ref);
      expect(MANIFEST.shapes).toContain(entry.shape);
    }
  });

  it("names one entry per pipe and shape", () => {
    const keys = MANIFEST.unshapeable.map((entry) => `${entry.pipe_ref}.${entry.shape}`);
    expect([...new Set(keys)].sort()).toEqual(keys.slice().sort());
  });

  it("states the refusal and the gap that retires it", () => {
    for (const entry of MANIFEST.unshapeable) {
      // The error type is what the runtime raised; the ledger item is the fix whose landing
      // makes the entry disappear from a regenerated manifest. An entry with neither is a
      // refusal nobody is tracking, which is the thing this record exists to prevent.
      expect(entry.error_type).not.toBe("");
      expect(entry.ledger_item).toMatch(/^L-\d{6}-[0-9a-f]{6}$/);
    }
  });

  it("is an exception list, not the whole corpus", () => {
    // Every (pipe, shape) unshapeable would mean the projection pins bytes the runtime
    // refuses outright — a broken capture wearing a complete declaration.
    expect(MANIFEST.unshapeable.length).toBeLessThan(
      MANIFEST.pipes.length * MANIFEST.shapes.length,
    );
  });
});

// The corpus landed before the projection on purpose, so the projection was written
// against a stated expectation rather than the expectation back-filled from it.
describe("the projection reproduces the corpus byte for byte", () => {
  for (const pipeRef of MANIFEST.pipes) {
    for (const shape of MANIFEST.shapes) {
      for (const format of MANIFEST.formats) {
        it(`${pipeRef} · ${shape} · ${format}`, () => {
          const rendered = renderInputsTemplate(INPUT_FORM[pipeRef], {
            explicit: shape === "explicit",
            format: format as InputsTemplateFormat,
          });
          expect(rendered).toBe(readTemplate(pipeRef, shape, format));
        });
      }
    }
  }
});
