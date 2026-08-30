import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIELD_KINDS } from "../../../src/protocol/input_form.js";
import type { InputForm, InputFormItem } from "../../../src/protocol/input_form.js";

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
 * Four jobs, three of which run today:
 *
 *  1. **Byte parity** — every corpus file reproduced exactly by the projection.
 *     Skipped until the projection exists (L-260829-f50e2b); it is the whole
 *     point of the corpus, and the reason the corpus lands first.
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
 */

const CORPUS_URL = new URL("../../fixtures/protocol/", import.meta.url);
const TEMPLATES_URL = new URL("inputs_template/", CORPUS_URL);

/**
 * Where the projection will live, and the surface this corpus checks. Named here
 * because the corpus is contract-first: it states the expectation before either
 * projection is written. If the projection lands under another name, update this
 * file in the same change — do not leave the check skipped.
 */
const PROJECTION_MODULE = "../../../src/protocol/inputs_template.js";
const PROJECTION_SOURCE = new URL("../../../src/protocol/inputs_template.ts", import.meta.url);

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

interface CorpusManifest {
  bundles: string[];
  pipes: string[];
  shapes: string[];
  formats: string[];
  divergences: DeclaredDivergence[];
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

// The projection is the deliverable of L-260829-f50e2b; the corpus lands before it
// on purpose, so this suite states the expectation the projection is written against.
const projectionExists = existsSync(fileURLToPath(PROJECTION_SOURCE));

describe.skipIf(!projectionExists)(
  "the projection reproduces the corpus byte for byte (skipped until src/protocol/inputs_template.ts exists — L-260829-f50e2b)",
  () => {
    for (const pipeRef of MANIFEST.pipes) {
      for (const shape of MANIFEST.shapes) {
        for (const format of MANIFEST.formats) {
          it(`${pipeRef} · ${shape} · ${format}`, async () => {
            const module = await import(/* @vite-ignore */ PROJECTION_MODULE);
            const rendered = module.renderInputsTemplate(INPUT_FORM[pipeRef], {
              explicit: shape === "explicit",
              format,
            });
            expect(rendered).toBe(readTemplate(pipeRef, shape, format));
          });
        }
      }
    }
  },
);
