# Protocol parity fixtures

`input_form.json` and `pipe_io_contracts.json` are one real payload pair of the two validate extension fields the MTHDS standard recommends — the input-form descriptor and the pipe I/O contracts — as the reference engine emits them. They pin the `mthds/protocol` types (`src/protocol/input_form.ts`, `src/protocol/pipe_io_contracts.ts`) to a payload a real derivation produced, and they are the parity link with `mthds-python`: that repo commits the **identical bytes** and parses them with its pydantic models, so the two mirrors of the standard are checked against one and the same payload. Do not edit the JSON — not to reformat it, and not to hide a divergence. Replacing it means regenerating it from the engine and replacing it in both repos.

## Provenance

- Bundles: `pipelex/tests/data/input_semantics/hinted_bundle.mthds` and `pipelex/tests/data/input_semantics/probe_bundle.mthds`.
- Command, run at the `pipelex` checkout root: `pipelex-dev trace-input-semantics tests/data/input_semantics/hinted_bundle.mthds tests/data/input_semantics/probe_bundle.mthds`. The trace's hop 5 outputs (`hop5_input_form.json`, `hop5_pipe_io_contracts.json`) are these two files, byte for byte.
- `pipelex` version `0.53.0` (`pyproject.toml`), checkout `bc97dad0b`.
- Pages the types follow: `mthds/docs/spec/input-form-descriptor.md` and `mthds/docs/spec/pipe-io-contracts.md` as published in MTHDS v0.9.0, with `mthds/docs/spec/intent-hints.md` for the `hints` slot.

## The twins

`input_form.fixture.ts` and `pipe_io_contracts.fixture.ts` are **generated** from the JSON by `npm run fixtures:protocol` (`scripts/gen-protocol-fixture-twins.mjs`). Each exports the same value as a TypeScript object literal declared with the artifact's type (`InputForm`, `PipeIOContracts`) — a JSON import would type every `kind` as `string`, and a fresh literal against the declared type gets the full excess-property and discriminant checks, which is what lets `tsc` (`npm run typecheck:test`) fail when the fixture and the types disagree. `tests/unit/protocol/input-form-parity.test.ts` asserts each twin deep-equals its JSON, so a twin that was not regenerated after the JSON changed fails `npm test` rather than drifting.

## Known engine drift

The page wins where the engine and the page disagree; the types follow the page, the fixture stays what the engine produced, and each divergence is tracked in the workspace ledger by the item named here. All three are visible in this payload:

- `native.Date` and `native.Html` input slots are still scalar kinds. Pipe `input_semantics_probe.probe_native_inputs`, slot `date_in` (`concept_ref: native.Date`) is `kind: "date"` and slot `html_in` (`native.Html`) is `kind: "prose"`; the page's ordered kind-assignment table puts both on the `object` arm, with `fields` from the pinned native definitions. Tracked by `L-260826-236839` (owner `pipelex`). The scalar kinds still parse against the union, so the compile-time check is unaffected.
- A `list`'s `item` carries a `name` member (the list's own name — `tags`, `ratings`, `gadgets`, `many`, `two`, `hinted_marked`, …); the page says an item has no authored name and carries no `name` member at all. Tracked by `L-260826-0ed8dd` (owner `pipelex`). This one is a shape divergence, so the generated twin carries a `@ts-expect-error` at exactly those sites, each naming the ledger item; the directive is self-cleaning — once a regenerated fixture no longer carries the divergence, the generator refuses to run until its `KNOWN_DIVERGENCES` entry is deleted, and a directive left behind would fail `tsc` as unused. A divergent item whose own subtree holds another divergent item gets no directive (TypeScript reports only the deepest error along a path, so an outer directive would be flagged unused); the generator counts those as shadowed.
- A description-only concept reports a `refines: ["native.Text"]` link nobody authored (`input_semantics_hinted.Essay`, `input_semantics_probe.PlainNote`, `input_semantics_probe.StringNote`); the page says `refines` is absent when the concept refines nothing and that text-valuedness reaches the wire as `kind: "prose"`, never as a fabricated link. Also tracked by `L-260826-0ed8dd`. `refines` is typed as an optional list, so the compile-time check is unaffected.
