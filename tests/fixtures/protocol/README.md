# Protocol parity fixtures

Everything in this directory is committed **byte-identically** here and in `mthds-python`, and `conformance/scripts/check-protocol-fixture-parity.py` compares the two mirrors file by file (`README.md` and the generated `*.fixture.ts` twins excepted — those are per-repo). Do not edit any of it by hand: a change is a new capture, landed in both repos.

`input_form.json` and `pipe_io_contracts.json` are one real payload pair of the two validate extension fields the MTHDS standard recommends — the input-form descriptor and the pipe I/O contracts — as the reference engine emits them. They pin the `mthds/protocol` types (`src/protocol/input_form.ts`, `src/protocol/pipe_io_contracts.ts`) to a payload a real derivation produced, and they are the parity link with `mthds-python`: that repo commits the **identical bytes** and parses them with its pydantic models, so the two mirrors of the standard are checked against one and the same payload. Do not edit the JSON — not to reformat it, and not to hide a divergence. Replacing it means regenerating it from the engine and replacing it in both repos.

## Provenance

- Bundles, in this order: `pipelex/tests/data/input_semantics/hinted_bundle.mthds`, `probe_bundle.mthds`, `scaffold_bundle.mthds`. The argument order decides the key order of the emitted maps, so it is part of the capture: a swapped order produces the same content with different bytes, which breaks the byte parity with `mthds-python`. A bundle added at the end keeps the existing bytes stable.
- Command, run at the `pipelex` checkout root:

  ```bash
  pipelex-dev generate-projection-corpus \
    tests/data/input_semantics/hinted_bundle.mthds \
    tests/data/input_semantics/probe_bundle.mthds \
    tests/data/input_semantics/scaffold_bundle.mthds \
    -o <dir>
  ```

  Copy `input_form.json`, `pipe_io_contracts.json` and the whole `inputs_template/` tree from `<dir>` into this directory and into `mthds-python`'s twin of it, then run `npm run fixtures:protocol` here. The `engine/` directory the command also writes is **not** committed: it holds the reference engine's own renderings, which is what the divergence record below is measured against.
- Engine: `pipelex`, at the change that introduced `pipelex-dev generate-projection-corpus` (its own page is `pipelex/docs/contribute/generate-projection-corpus.md`). That command replaced `trace-input-semantics` as the producer of these files; generating from the two original bundles alone reproduces the previous capture byte for byte, so the move was a no-op diff.
- Pages the types follow: `mthds/docs/spec/input-form-descriptor.md` and `mthds/docs/spec/pipe-io-contracts.md` as published in MTHDS v0.9.0, with `mthds/docs/spec/intent-hints.md` for the `hints` slot.

## The inputs templates

`inputs_template/` is the second half of the corpus, and the reason it grew: a pipe's fill-in inputs template is now projected **client-side** from the descriptor beside it, once here and once in `mthds-python`, and the two projections must produce the same bytes — TOML `# concept:` comment lines included — or the JS/Python asymmetry that retiring the server-side build routes removed is simply rebuilt one layer up.

One file per pipe, shape and format: `<pipe_ref>.<compact|explicit>.<json|toml>`, holding the projection's exact return value (the JSON carries no trailing newline; the TOML carries exactly one). `inputs_template/manifest.json` states what the corpus covers, where it departs from the reference engine's own inputs-template renderer, and which of its own templates the runtime's input shaper refuses today.

The corpus is **contract-first**: it landed before either projection, so each was written against a stated expectation instead of the expectation being back-filled from whatever the first implementation happened to emit. This side's projection is `src/protocol/inputs_template.ts`, with the TOML half in `src/protocol/toml_emitter.ts`; `tests/unit/protocol/inputs-template-projection.test.ts` runs the corpus's five jobs against it — byte parity, kind coverage against the whole closed `FIELD_KINDS` vocabulary, file-set completeness, the divergence lapse check, and the integrity of the unshapeable record. The rules the corpus cannot reach are stated on their own beside it: `toml-emitter.test.ts` holds each layout rule as bytes, and `inputs-template-rendering.test.ts` the forms no captured bundle produced — an input-less pipe, a plural native slot, an unknown format.

### Why it departs from the engine, deliberately

The expectation is not the engine's output. It is authored by a reference projection that walks the **descriptor** — the authored facts a method states — where the engine's renderer reflects the **runtime content classes**; the shipped projections have only the descriptor, so the contract has to be authored from it too. Each class of difference is declared in the manifest with worked sites, so the record can be checked here with no engine present, and the generator refuses to write a capture holding an undeclared difference — or one whose declared class has stopped occurring, so an engine fix retires its entry deliberately:

- `optional-field-included` — an optional structure field is rendered at every depth; the engine hides one at depth 1 and shows one nested deeper.
- `file-leaf-not-expanded` — a `document`/`image` node is a leaf carrying only its URL; the engine expands the runtime content class and asks for a width, a mime type and a caption.
- `fixed-count-honoured` — a `Concept[N]` slot renders N elements; the engine emits one, which the runtime's own input shaper then rejects, so its template does not run.
- `text-named-url` — a text field merely **named** `url` takes a text placeholder; the engine picks a placeholder by field name.
- `object-native-keeps-envelope` — a native that renders as an object once its optional field is included keeps its `{concept, content}` envelope, because the shaper dispatches a native's bare value on its scalar kind and would reject the bare object. The engine unwraps to a scalar, which it can only do because it drops the optional field. A consequence of the first entry.

Each entry carries the workspace-ledger item tracking the engine fix, or `null` where the difference is one of vantage rather than a defect — the file-leaf entry is the descriptor's vantage, and the object-native one is a consequence of the optional-field entry rather than its own bug.

The templates are held to a second bar that is easy to lose sight of behind the byte parity: they must still **run**. A template is what someone fills in and hands back, so every slot of it has to survive the runtime's own input shaper. That is what separates a deliberate divergence from a projection bug — the file-leaf entry pins `{"url": ...}` because the shaper accepts exactly that wrapper, and the object-native entry keeps the envelope for the same reason. Where a class is retired, the corpus is regenerated and its entry disappears from the manifest on its own.

That bar is now measured rather than argued. The generator hands every projected template, in both shapes, to `InputShaper.shape` at capture time and writes the verdict into the manifest's `unshapeable` array — one entry per refused `(pipe_ref, shape)`, carrying the error's class name and the ledger item whose fix retires it — refusing to write a capture that holds a refusal nobody declared, or that declares one which has started shaping. The entries this capture carries are the four templates blocked on `L-260830-191719`, the nested-list slot the shaper cannot take back.

The array is a statement the corpus makes about itself, and this repo cannot re-derive it: there is no input shaper on this side of the mirror, so the verdict is taken on the generator's authority. What the suite here checks is that the record stays about *this* corpus — every entry keyed to a pipe and shape the manifest holds, one entry per key, each naming a real error type and a real ledger item, and the array an exception list rather than the whole corpus. A consumer harness may read the entries to know which pinned templates it must not expect to run; nothing requires it to.

## The twins

`input_form.fixture.ts` and `pipe_io_contracts.fixture.ts` are **generated** from the JSON by `npm run fixtures:protocol` (`scripts/gen-protocol-fixture-twins.mjs`). Each exports the same value as a TypeScript object literal declared with the artifact's type (`InputForm`, `PipeIOContracts`) — a JSON import would type every `kind` as `string`, and a fresh literal against the declared type gets the full excess-property and discriminant checks, which is what lets `tsc` (`npm run typecheck:test`) fail when the fixture and the types disagree. `tests/unit/protocol/input-form-parity.test.ts` asserts each twin deep-equals its JSON, so a twin that was not regenerated after the JSON changed fails `npm test` rather than drifting.

## Known engine drift in the descriptor and contract payloads

A different question from the template divergences above: this is about whether the two captured payloads match the pages the types mirror. None. Every divergence the previous capture carried has been fixed in the engine, and this capture shows the fixed behaviour: a `list`'s `item` carries no `name` member, `native.Date` and `native.Html` slots land on the `object` arm with `fields` from the pinned native definitions (and `native.Html`'s `css_class` is optional), and a description-only concept no longer reports a `refines: ["native.Text"]` link nobody authored. The items that tracked those — `L-260826-0ed8dd`, `L-260826-236839`, `L-260826-3cea94`, all owned by `pipelex` — are closed, and the `@ts-expect-error` suppressions the old capture forced are gone from the twins.

The machinery that absorbed them is still in place, because the next divergence is cheaper to record than to rediscover. The rule for a future one: the page wins where the engine and the page disagree, so the types follow the page and the fixture stays what the engine produced — never edited to hide the difference. A shape divergence is declared as a `KNOWN_DIVERGENCES` entry in `scripts/gen-protocol-fixture-twins.mjs` naming the ledger item that tracks the engine fix, which puts a `@ts-expect-error` on exactly the matching sites of the generated twin. That directive is self-cleaning in both directions: once a regenerated fixture no longer carries the divergence the generator refuses to run until the entry is deleted, and a directive left behind by hand fails `tsc` as unused. A divergent site whose own subtree holds another divergent site gets no directive — TypeScript reports only the deepest error along a path, so an outer directive would be flagged unused — and the generator counts those as shadowed. A divergence that still parses against the union (a scalar where the page wants an object, an extra optional member) needs no entry at all; it is recorded here in prose.

## The `json_schema` projection is the producer's, not the page's

`pipe_io_contracts.json` carries `json_schema` values projected from `pipelex`'s runtime pydantic content classes, so they hold pydantic's auto-generated per-field titles — `"title": "Inner Html"` on `native.Html`'s `inner_html`, which no pinned definition states. **This is not drift, and it should not be re-opened as one.** `mthds/docs/spec/pipe-io-contracts.md:44` leaves the projection's content to the producer beyond the two rules in "The input schema", and `:124` says outright that a producer MAY carry identity or description inside the schema document as `title` and that consumers MUST NOT depend on it — `concept_ref` is the authoritative statement of identity.

What the projection path *is* held to, since `pipelex` #1155: `tests/unit/pipelex/core/concepts/test_pinned_natives_vs_standard.py` holds `pinned_blueprints.py` to `mthds/docs/spec/native-concepts.md` read unpinned at the standard's default branch, and `tests/unit/pipelex/codegen/test_native_expansion.py` holds each runtime content class to its pinned blueprint. The two hops are machine-checked in a chain, which is why a schema projected from the content class can be trusted to state the pinned facts even though it also states dialect ones.
