---
name: contract-check
description: Detect interface-contract drift between this package's code and a baseline (defaults to the last release tag, but the user can specify any tag or commit). Compares the source files behind the mthds-js provided/consumed/implemented interfaces — the mthds-agent CLI, the MTHDS Protocol API runner, plxt/pipelex-agent passthrough, and the hook pipeline — against the interface specs in ../conformance/specs/. Use when the user says "check the contract", "contract review", "contract check", "did we break the contract", "check interfaces", "API contract", "protocol drift", "compare to vX.Y.Z", or before shipping/releasing a version that touches CLI, API-runner, protocol, or passthrough code. Also trigger automatically before the /release skill runs, and proactively when you notice such changes during a PR review.
---

# Contract Check

Detects discrepancies between the interfaces this package implements or consumes and the specs that document them. "Interface" here is broader than the CLI: it includes the `mthds-agent` CLI, the **MTHDS Protocol** wire surface the API runner implements (`MthdsApiClient`), the `plxt` / `pipelex-agent` passthrough, and the hook pipeline. A discrepancy means the code and the spec disagree — but this skill does NOT presume which side is wrong. The code may need fixing, the spec may need updating, or both. That judgment belongs to the human reviewing the report.

The output is a summary in the session plus one **workspace ledger item per actionable finding**, owned by the repo that has to act on it. It is never a report file: see Step 6.

## Prerequisites: Locate the Specs

The specs live in the `conformance` repo, in its `specs/` directory beside the tests that verify them. Every checkout of mthds-js, the main one and each `_mthds-js--<topic>` worktree, sits directly under the workspace root beside the `conformance` checkout, so from the mthds-js repo root the specs are at `../conformance/specs/`. Before doing anything else:

1. Check that the directory `../conformance/specs/` exists.
2. Check that it contains at least `mthds-agent-cli.md` (the one spec mthds-js owns).
3. Also check for `pipelex-mthds-protocol.md`, `plxt-cli.md`, and `hook-lint-pipeline.md` — these are required by Step 4.

If the directory is missing or does not contain the expected spec files, **stop immediately** and tell the user:

> The interface specs directory was not found at `../conformance/specs/`. You need the `conformance` repo checked out at the workspace root, beside this one. Please contact the Pipelex staff to get access.

Do not proceed with the review if specs are missing.

### The spec set in scope

`conformance/specs/` holds more specs than this skill checks. Only these touch mthds-js code:

| Spec | mthds-js's relationship | Owner repo |
|---|---|---|
| `mthds-agent-cli.md` | **owns** — defines the `mthds` + `mthds-agent` CLIs this package ships | mthds-js |
| `pipelex-mthds-protocol.md` | **implements/consumes** — the API runner (`MthdsApiClient`) is a protocol client; the wire shapes (validate report + model deck, RFC 7807 errors, `pipe_ref` identity) are this spec | pipelex + pipelex-api |
| `mthds-input-form-descriptor.md` | **implements** — the carriage spec for the two standard-owned validate extensions (`pipe_io_contracts`, `input_form`) that `src/protocol/pipe_io_contracts.ts` and `src/protocol/input_form.ts` type; it defers the artifacts' *shape* to the normative pages in `mthds/docs/spec/`, so check both | pipelex + pipelex-api (carriage), the standard (shape) |
| `plxt-cli.md` | **consumes** — passthrough invokes the `plxt` binary | vscode-pipelex |
| `hook-lint-pipeline.md` | **participates** — the hook calls `mthds-agent validate bundle`, and `codex-hook.ts` runs a parallel lint→fmt→validate pipeline | mthds-plugins |
| `pipelex-codegen.md` | **consumes** — its "The pipe I/O route" section, with the crate envelope it shares from "Route envelopes" (`files[]` XOR `method_ref`, the qualified `pipe_ref`, the discriminated `is_valid` verdict), is the wire surface `MthdsApiClient.pipeIo()` in `src/runners/api/client.ts` calls, and that `mthds-agent inputs` and `mthds build inputs` read on the API runner | pipelex + pipelex-api |

The other specs (`pipelex-validation-api.md`, `mthds-ui-graph-viewer.md`) describe surfaces mthds-js neither ships nor calls — ignore them unless the user asks.

## Step 1 — Identify the Baseline

If the user specified a baseline (e.g., "compare to v0.1.3" or "check against abc1234"), use that directly.

Otherwise, default to the latest release tag:

```bash
git tag --sort=-v:refname | head -1
```

Confirm the chosen baseline with the user before proceeding: "Comparing against `<baseline>`. Continue?"

This matters because the user may want to compare against an older release to catch cumulative drift, or against a specific commit for a targeted review.

## Step 2 — Detect Contract-Affecting Changes

Diff the baseline against HEAD, scoped to the files behind the interfaces above. There are two ways to know which files those are — use both:

### a) Front-matter-derived scope (for the spec mthds-js owns)

Each spec carries front matter listing the source globs that implement it:

```yaml
id: mthds-agent-cli
sources:
  - mthds-js/src/agent-cli.ts
  - mthds-js/src/agent/**/*.ts
```

Read `../conformance/specs/mthds-agent-cli.md`'s `sources:` and diff exactly those globs (strip the `mthds-js/` prefix — you are already in that repo). This self-maintains as files move, so prefer it over a hardcoded list for the owned spec.

### b) Explicit map (for specs mthds-js consumes/implements)

`pipelex-mthds-protocol.md`, `plxt-cli.md`, and `hook-lint-pipeline.md` list **other** repos' files in their `sources:` (pipelex, pipelex-api, vscode-pipelex, mthds-plugins) — mthds-js is a consumer/implementer they don't name. So for these, use this explicit map of the mthds-js files that ride each contract:

| Spec | mthds-js files |
|---|---|
| `pipelex-mthds-protocol.md` | `src/runners/api/**` (the `MthdsApiClient` wire surface, run lifecycle, Dict models, transport errors), `src/protocol/**` (the protocol interface + wire models), `src/runners/types.ts` |
| `mthds-input-form-descriptor.md` | `src/protocol/pipe_io_contracts.ts`, `src/protocol/input_form.ts` (the typed validate extensions) |
| `plxt-cli.md` | `src/agent/passthrough.ts`, `src/agent/binaries.ts` (how `plxt` is invoked and version-pinned) |
| `hook-lint-pipeline.md` | `src/agent/commands/codex-hook.ts`, plus the `mthds-agent validate bundle` surface in `src/agent/commands/` |

### Always also diff

- `src/cli.ts`, `src/cli/commands/**` — the `mthds` interactive CLI (no machine spec; awareness-only)
- `src/agent/commands/pipelex-commands.ts` — pipelex runner stub commands (Step 4 stub-sync check)
- `CHANGELOG.md` — entries since the baseline that mention CLI/API/protocol changes, new/removed/renamed commands or fields, or output-format changes

Run, for example:

```bash
git diff <baseline-tag> HEAD --name-only -- \
  src/cli.ts src/cli/commands/ \
  src/agent-cli.ts src/agent/ \
  src/runners/ src/protocol/ \
  CHANGELOG.md
```

(`src/runners/` covers the API-runner protocol surface and `types.ts`; `src/agent/` covers the agent CLI, passthrough, binaries, and the codex hook.)

If **no files changed**, report that no contract-affecting changes were detected and stop.

If files changed, proceed to Step 3.

## Step 3 — Classify the Changes

For each changed file, get the actual diff:

```bash
git diff <baseline-tag> HEAD -- <file>
```

Classify each change into one of:

- **Contract-visible**: changes to command names, subcommands, arguments, options, exit codes, error shapes/types, **wire-shape fields, request/response models, HTTP status semantics**, or passthrough behavior. These are things a consumer or spec would care about.
- **Internal-only**: refactors, logging, cosmetic changes, or internal implementation details that don't affect the external interface.

Also scan the CHANGELOG entries added since the baseline for any mention of:
- New commands, subcommands, or routes
- Removed or renamed commands, options, arguments, or wire fields
- Changed output format, error protocol, or HTTP status semantics
- Breaking changes

## Step 4 — Review Against Specs

For each contract-visible change, read the relevant spec and compare:

| What changed | Spec to check |
|---|---|
| `mthds-agent` commands, options, output/envelope format, error types | `../conformance/specs/mthds-agent-cli.md` |
| API-runner wire shapes — validate report/result union, model deck, version handshake, request/response models, HTTP status semantics, RFC 7807 error bodies, `pipe_ref` identity | `../conformance/specs/pipelex-mthds-protocol.md` |
| Passthrough to `plxt` (arguments, flags forwarded, version pin) | `../conformance/specs/plxt-cli.md` |
| Passthrough to `pipelex-agent` | `../conformance/specs/mthds-agent-cli.md` (runner-aware section) |
| Hook-facing behavior (`codex-hook.ts`, the lint/fmt/validate pipeline, the `validate bundle` envelope the hook parses) | `../conformance/specs/hook-lint-pipeline.md` |
| Pipe I/O route shapes — the `files[]` XOR `method_ref` envelope, `pipe_ref` selection and its refusal `error_type`s, the `200` + `is_valid` verdict discipline | `../conformance/specs/pipelex-codegen.md` |
| The standard's validate extensions — the `pipe_io_contracts` contract members, the closed `FieldKind` union and its per-kind slots, the common field slots, where `item_count` is present versus `null` | `../conformance/specs/mthds-input-form-descriptor.md` for the carriage, and the normative shape pages it points at (`mthds/docs/spec/pipe-io-contracts.md`, `mthds/docs/spec/input-form-descriptor.md`, `mthds/docs/spec/intent-hints.md`) |
| `mthds` interactive CLI | No spec exists yet — flag new commands/options for the user's awareness, but no spec comparison needed |

**Pipelex stub sync check** (always run, even if `pipelex-commands.ts` itself didn't change):

Compare the commands registered in `src/agent/commands/pipelex-commands.ts` against the runner-aware commands listed in `mthds-agent-cli.md` (Runner-Aware Commands section). Flag any mismatch:
- A command in the spec but missing from the stubs → it won't appear in `mthds-agent --help` with the default pipelex runner
- A stub not in the spec → the spec is stale
- A command in `api-commands.ts` but missing from `pipelex-commands.ts` (or vice versa) → the two runner implementations are out of sync

This is critical because mismatches are silent — the command still works via the catch-all fallback, but users and agents won't discover it through `--help`.

For each contract-visible change, determine:

1. **Is the change documented in the spec?** (the spec already describes the new behavior)
2. **Does the change contradict the spec?** (the code now does something the spec says it doesn't)
3. **Is the change absent from the spec?** (new behavior not yet documented)

**When citing a spec surface, note its conformance status.** Each verified surface in `conformance/specs/` carries a `> Verified by:` line pointing at the test under `conformance/tests/` that exercises it (or an explicit `<!-- unverified: ... -->` marker). When a finding touches a surface, include its `> Verified by:` target (or note it's unverified) so the reviewer knows whether a test already guards it.

## Step 5 — Report

Present the findings in the session. This is what the human reading the check sees, and it is the whole output for anything that is not actionable.

Every **Discrepancy** and **Unmatched Addition** section must be written **self-contained** — readable by someone who has never seen this codebase — because Step 6 files it verbatim as the body of a ledger item, and the agent who picks that item up will be working in a different repo with none of your context. Write each one once, well enough to hand over.

Start the report with a header block, then the summary table, then the detailed sections.

### Header Block

```markdown
# Contract Check — mthds-js

**Date**: YYYY-MM-DD
**Repo**: mthds-js (npm: `mthds`)
**Branch**: <current branch>
**Baseline**: `<tag>` (user-specified | auto-detected)
**Target**: HEAD (`<commit short hash>`)

**Specs checked**:
- `conformance/specs/mthds-agent-cli.md` — mthds-agent CLI (owned by mthds-js)
- `conformance/specs/pipelex-mthds-protocol.md` — MTHDS Protocol wire surface (owned by pipelex + pipelex-api; implemented by the API runner)
- `conformance/specs/plxt-cli.md` — plxt CLI (owned by vscode-pipelex; consumed via passthrough)
- `conformance/specs/hook-lint-pipeline.md` — hook pipeline (owned by mthds-plugins; participated in by codex-hook.ts)
- `conformance/specs/pipelex-codegen.md` — the pipe I/O route and the crate envelope it shares (owned by pipelex + pipelex-api; consumed by the API runner)
- `conformance/specs/mthds-input-form-descriptor.md` — carriage of the standard's validate extensions (shape owned by the standard; typed in `src/protocol/`)
```

### Summary Table

```
| Category               | Count | Resolution needed? |
|------------------------|-------|--------------------|
| Discrepancies          | N     | Yes                |
| Unmatched additions    | N     | Yes                |
| Aligned changes        | N     | No                 |
```

Follow the table with a one-line verdict, e.g.: "3 discrepancies require resolution before release." or "All clear — code and specs are aligned."

---

### Discrepancies

Places where the code and the spec disagree. For each discrepancy:

1. **What the code does** — describe the actual behavior with file path and line reference
2. **What the spec says** — quote or paraphrase the relevant spec section with file path and section reference, plus its conformance status (`> Verified by:` target or unverified)
3. **What changed** — which side moved? Did the code change since the baseline? Was the spec recently updated? Or is it unclear?

Do NOT recommend which side should change. State the facts and let the reviewer decide. If there is obvious context that helps (e.g., the CHANGELOG explicitly labels something as an intentional breaking change), include it — but still don't prescribe the fix.

### Unmatched Additions

Behaviors present in only one side:
- **In code but not in spec**: new commands, options, wire fields, or error types that the spec doesn't mention
- **In spec but not in code**: documented commands, options, or fields that don't exist in the implementation

For each, state clearly which side has it and which side lacks it.

### Aligned Changes

Changes that are consistent between code and spec. List briefly for completeness.

---

## Step 6 — File the Actionable Findings as Ledger Items

The report itself is not written to a file. Findings that somebody must act on become **workspace ledger items**, one per finding, owned by the repo that has to act. Everything else stays in the printed report and goes nowhere.

This is the workspace rule — no inbox files, no `_top_priorities.md`, no ad hoc follow-up lists — and a `wip/contract-check-*.md` report is exactly the pile it replaced. The contract is `ledger/README.md`; the `/ledger` skill has the full command reference.

### 6a — Decide what is actionable

| Report section | Destination |
|---|---|
| **Discrepancies** | one ledger item each |
| **Unmatched Additions** | one ledger item each |
| **Aligned changes** | the printed report only — nothing is filed |
| `mthds` interactive CLI notes (no spec exists) | the printed report only, unless the user asks for one |
| Stable knowledge the check surfaced that is *information rather than work* — e.g. why two runners deliberately diverge on a surface | `mthds-js/docs/`, in the same change |

### 6b — Fix in place what belongs here

Before filing anything owned by `mthds-js`, ask the user whether to fix it now. **The ledger is for work crossing a boundary you cannot or should not cross — never a way to defer your own.** A finding whose fix is a small, obvious change in this repo should be made in this session; file it only when it is genuinely out of scope (it predates the baseline and is unrelated to the change in hand, or the fix is a design call the user does not want to take now).

### 6c — Check for an existing item first

This check runs before every release, against a moving baseline, so the same drift resurfaces run after run. **Filing it twice is the failure mode.** Every item this skill files carries `--ref skill:contract-check`, which is what makes the previous run's output findable:

```bash
ledger list --ref skill:contract-check --status open
ledger list --ref spec:conformance/specs/<file>   # prefix match on the surface
```

If an open item already covers the finding, do not file a second one. Record the new sighting on the existing item and move on:

```bash
ledger note <id> "Still open at baseline <baseline> → HEAD <short-sha>."
```

Mention the existing ID in the report so the reader sees it was already tracked.

### 6d — Pick the owner and the type

`--owner` is the repo that *fixes* it — not the repo that found it. Note that the specs live in the `conformance` repo beside the tests that verify them, so a spec edit and its conformance test pair are owned by `conformance`, never by mthds-js.

| What resolving the finding requires | `--owner` | `--type` |
|---|---|---|
| An mthds-js code change | `mthds-js` | `bug` if shipped behavior is wrong, else `task` |
| A `conformance/specs/` edit (and its conformance test pair) | `conformance` | `spec` |
| A change in another implementation of the same spec — `pipelex`, `pipelex-api`, `vscode-pipelex`, `mthds-plugins` | that repo | `bug` or `task` |
| **Which side is wrong is genuinely undetermined** | `workspace` | `decision` |

That last row is how this skill keeps its stance: it detects drift and does not assign blame. When the code and the spec disagree and neither is obviously the one that moved, the finding is a call only a person can make — file it as a `decision` with `## Options` and `## Recommendation`, not as a task pointed at whichever side is easier to change.

Severity follows who breaks, not how big the diff is:

- `high` — a shipped consumer (an AI agent, the `mthds` plugin, `pipelex-app`, `conformance`) reads the surface and would act on the wrong description; or the code contradicts a spec surface that carries a `> Verified by:` link, so a conformance test is already lying or about to fail.
- `normal` — an undocumented addition: the code works, the spec under-describes it.
- `low` — wording, or awareness-only.

### 6e — Write the body and file

Write each finding's body to a scratch file and pass it with `--body-from`; never hand-write an item file. The body is the report section you already wrote in Step 5, arranged into the required sections:

- `## What` — the disagreement, plainly, as if the reader has never seen this repo.
- `## Evidence` — required. `repo/path/file.ext:line` on both sides (the code site *and* the spec line), the commands you ran (`git diff <baseline> HEAD -- <file>`, the `grep` that came back empty), and the surface's conformance status: its `> Verified by:` target, or that it is unverified.
- `## Why it was not fixed in place` — required whenever the owner is not `mthds-js`. Name the boundary: the spec lives in the `conformance` repo and its conformance test must move with it in the same pull request; the passthrough contract is `vscode-pipelex`'s; and so on.
- `## Suggested fix` — optional but valuable here, and say how confident you are. State the options; do not prescribe which side changes.
- `## Options` / `## Recommendation` — required on a `decision`.

Then file it:

```bash
ledger new \
  --owner conformance --type spec --severity normal \
  --theme cross-repo-hygiene \
  --title "…" \
  --ref skill:contract-check \
  --ref "spec:conformance/specs/<file>#<section>" \
  --ref mthds-js/src/<path>.ts \
  --body-from <scratch-path>
```

`--theme` takes a key from `ledger/heat.toml`; `cross-repo-hygiene` is the right default for spec-versus-code drift — use a more specific existing theme when the finding plainly belongs to one. `--ref skill:contract-check` is not optional: it is the dedupe key 6c depends on.

The three ref kinds each earn their place. `skill:contract-check` is provenance and dedupe. `spec:…` is prefix-matched by `ledger list --ref`, so the anchor costs nothing and helps. And the bare `repo/path/file.ts:line` — line number and all, which `ledger doctor` strips before checking the path resolves — is what `ledger match --path` compares against the files a merged PR touched, so a fix that lands without naming the item in its body is still found as a ride-along.

Link the item when something genuinely connects: `--discovered-from <id>` when this run was triggered by other work already in the ledger, `--blocked-by <id>` when it cannot start until another item closes.

**When one run produces a cascade** — several findings that only make sense together, e.g. a whole route family undocumented across two specs plus the conformance arm it needs — erect the epic first and attach the findings to it:

```bash
ledger new --type epic --owner workspace --theme <theme> --title "…"
ledger new --owner <repo> --parent <epic-id> --title "…"
```

### 6f — Report what was filed, then commit

Close the session's report with the IDs, so the human can see the check's output as work rather than prose:

```
Filed:
  L-…  conformance  spec  Document `run start` in the mthds-agent CLI spec
  L-…  mthds-js     bug   Register the `codegen` stub on the API runner
Already tracked:
  L-…  (noted this run's sighting)
```

Then:

```bash
ledger validate
ledger commit
```

`ledger commit` is the only thing that sends the ledger anywhere. A check that files items and does not commit leaves them on this machine alone.

## Notes

- **Never write a `wip/contract-check-*.md` report.** That was this skill's output until the workspace ledger existed, and it is the shape the ledger replaced: a file nobody reads, in a repo that often is not the one that has to act. Findings go to `ledger new` (Step 6), durable knowledge goes to `mthds-js/docs/`, and the summary goes to the session.
- **Specs and conformance are a linked pair.** If the resolution to a finding is to edit a spec in `conformance/specs/`, the matching test under `conformance/tests/` must be updated in the same change, and `make check-spec-links` (run from the `conformance` repo) must pass — it enforces the bidirectional `> Verified by:` ↔ `pytestmark = pytest.mark.spec(...)` links. A spec edit that renames a heading or documents a new surface without touching its test will fail that gate. Say so in the item body whenever a finding points at a spec edit — the agent who picks it up needs to know the spec and its test move together in one `conformance` pull request.
- The `mthds` interactive CLI does not have a spec yet (it's user-facing, not machine-facing). Flag notable changes for awareness but don't treat them as spec violations.
- The `mthds-agent` CLI spec and the MTHDS Protocol spec are the most critical, because AI agents, the `skills` plugin, and `pipelex-app` depend on their exact output/wire formats.
- When checking passthrough behavior, pay special attention to how arguments are constructed and forwarded — even small changes (extra flags, different ordering) can break downstream consumers.
- This skill detects discrepancies — it does not assign blame. The code might be wrong, the spec might be stale, or both might need updating. That's a human decision, and when the check cannot tell which side moved, the item it files is a `decision` (Step 6d) rather than a task pointed at one side.
