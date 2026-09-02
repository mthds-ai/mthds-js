---
status: active
item: L-260829-f50e2b
---

# Inputs-template projection — review follow-ups

Deferrals from the review of PR [#117](https://github.com/mthds-ai/mthds-js/pull/117) (`feature/Inputs-template-projection`), which added `src/protocol/inputs_template.ts` and `src/protocol/toml_emitter.ts`. Each entry records what was found, why it did not land on that branch, and what would settle it.

## Narrow `EnumFieldNode.choices` from `unknown[]` to `string[]`

**Where:** `src/protocol/input_form.ts`, the `EnumFieldNode` interface.

**Reported by:** surfaced while verifying a Greptile comment on `src/protocol/inputs_template.ts:392` during round 1. The comment itself was a false positive (see below); this is the real observation left behind after it was dismissed.

**What.** The descriptor type declares `choices: unknown[]`, while both the standard and the Python twin say choices are strings:

- `mthds/docs/spec/mthds-format.md:154` and `:181` — an enum's choices are an array of strings, and the value "MUST be one of the strings in the `choices` array".
- `mthds-python/mthds/protocol/input_form.py:270` pins `choices: list[str]`.

So the two mirrors of the same wire artifact disagree on this one member's type, and the TS side is the looser of the two. Narrowing it to `string[]` would match the page and the twin, and would incidentally make the `as TemplateValue` cast at `inputs_template.ts:392` unnecessary rather than merely safe.

**Why it was deferred rather than fixed on that branch.** It is a public type-surface change on the `mthds/protocol` subpath, to a file PR #117 does not touch (`input_form.ts` last changed before the branch), and it fixes no reachable runtime behaviour — every enum choice that can actually arrive already renders correctly in both serializations. Folding a breaking type change into a review round of an unrelated branch is the wrong place for it.

**Why the cast it would remove is not itself a defect** — worth recording so nobody re-opens the closed half of this. The descriptor is only ever materialised by `JSON.parse` off the validate response (`src/runners/api/client.ts:462`, no reviver), and `TemplateValue` (`src/protocol/toml_emitter.ts:120-127`) is the same set of shapes JSON can carry, so every value that can reach `choices[0]` is already a `TemplateValue`. Reaching a value the serializers refuse needs `undefined`, a function, a symbol or a `Date` — none expressible in JSON, all reachable only from a hand-written descriptor, which is precisely what `InputsTemplateError` and `TomlEmissionError` document themselves as covering ("a programming error, never bad input"). A runtime guard would also be a JS-only divergence: the Python twin returns `node.choices[0]` equally unguarded (`mthds-python/mthds/protocol/inputs_template.py:305-309`), and byte identity with it is the bar the module is built to. The narrowing is therefore a type-hygiene and spec-conformance change, **not** a fix for a latent bug — if it is done, it should be done for that reason and not as a bug fix.

**What settles it.** Decide whether the descriptor page's `choices` is string-typed on both sides (it reads that way today), then change the TS type in one deliberate commit with a changelog line, since it is a breaking narrowing of an exported type. No `mthds-python` change is needed — it already pins `list[str]`.

## Not deferred, recorded so it is not re-litigated

Two other round-1 findings were dismissed as false positives and need no follow-up here:

- **Enum choices "bypass serialization checks"** (Greptile, `inputs_template.ts:392`) — the reasoning above. The bot had the mechanism right and the trigger wrong.
- **`unknown` natives emit an unshapeable `{}`** (local Codex run, `inputs_template.ts:361`) — `{}` is the stated contract for an `unknown` node and is identical in all three implementations, so a JS-only special case would break byte parity. The real gap underneath it is corpus coverage owned by `pipelex` and is tracked as its own ledger item, `L-260831-264cbd`.
