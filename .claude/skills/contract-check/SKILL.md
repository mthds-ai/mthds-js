---
name: contract-check
description: Detect interface-contract drift between this package's code and a baseline (defaults to the last release tag, but the user can specify any tag or commit). Compares the source files behind the mthds-js provided/consumed/implemented interfaces — the mthds-agent CLI, the MTHDS Protocol API runner, plxt/pipelex-agent passthrough, and the hook pipeline — against the interface specs in ../docs/specs/. Use when the user says "check the contract", "contract review", "contract check", "did we break the contract", "check interfaces", "API contract", "protocol drift", "compare to vX.Y.Z", or before shipping/releasing a version that touches CLI, API-runner, protocol, or passthrough code. Also trigger automatically before the /release skill runs, and proactively when you notice such changes during a PR review.
---

# Contract Check

Detects discrepancies between the interfaces this package implements or consumes and the specs that document them. "Interface" here is broader than the CLI: it includes the `mthds-agent` CLI, the **MTHDS Protocol** wire surface the API runner implements (`MthdsApiClient`), the `plxt` / `pipelex-agent` passthrough, and the hook pipeline. A discrepancy means the code and the spec disagree — but this skill does NOT presume which side is wrong. The code may need fixing, the spec may need updating, or both. That judgment belongs to the human reviewing the report.

## Prerequisites: Locate the Specs

The specs live at `../docs/specs/` (relative to the mthds-js repo root, i.e. the sibling `docs` repo). They were previously called "contracts" and lived in `../docs/contracts/` — that path is gone; use `../docs/specs/`. Before doing anything else:

1. Check that the directory `../docs/specs/` exists.
2. Check that it contains at least `mthds-agent-cli.md` (the one spec mthds-js owns).
3. Also check for `pipelex-mthds-protocol.md`, `plxt-cli.md`, and `hook-lint-pipeline.md` — these are required by Step 4.

If the directory is missing or does not contain the expected spec files, **stop immediately** and tell the user:

> The interface specs directory was not found at `../docs/specs/`. You need access to the `docs` repo. Please contact the Pipelex staff to get access.

Do not proceed with the review if specs are missing.

### The spec set in scope

`docs/specs/` holds more specs than this skill checks. Only these four touch mthds-js code:

| Spec | mthds-js's relationship | Owner repo |
|---|---|---|
| `mthds-agent-cli.md` | **owns** — defines the `mthds` + `mthds-agent` CLIs this package ships | mthds-js |
| `pipelex-mthds-protocol.md` | **implements/consumes** — the API runner (`MthdsApiClient`) is a protocol client; the wire shapes (validate report + model deck, RFC 7807 errors, `pipe_ref` identity) are this spec | pipelex + pipelex-api |
| `plxt-cli.md` | **consumes** — passthrough invokes the `plxt` binary | vscode-pipelex |
| `hook-lint-pipeline.md` | **participates** — the hook calls `mthds-agent validate bundle`, and `codex-hook.ts` runs a parallel lint→fmt→validate pipeline | mthds-plugins |

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

Read `../docs/specs/mthds-agent-cli.md`'s `sources:` and diff exactly those globs (strip the `mthds-js/` prefix — you are already in that repo). This self-maintains as files move, so prefer it over a hardcoded list for the owned spec.

### b) Explicit map (for specs mthds-js consumes/implements)

`pipelex-mthds-protocol.md`, `plxt-cli.md`, and `hook-lint-pipeline.md` list **other** repos' files in their `sources:` (pipelex, pipelex-api, vscode-pipelex, mthds-plugins) — mthds-js is a consumer/implementer they don't name. So for these, use this explicit map of the mthds-js files that ride each contract:

| Spec | mthds-js files |
|---|---|
| `pipelex-mthds-protocol.md` | `src/runners/api/**` (the `MthdsApiClient` wire surface, run lifecycle, Dict models, transport errors), `src/protocol/**` (the protocol interface + wire models), `src/runners/types.ts` |
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
| `mthds-agent` commands, options, output/envelope format, error types | `../docs/specs/mthds-agent-cli.md` |
| API-runner wire shapes — validate report/result union, model deck, version handshake, request/response models, HTTP status semantics, RFC 7807 error bodies, `pipe_ref` identity | `../docs/specs/pipelex-mthds-protocol.md` |
| Passthrough to `plxt` (arguments, flags forwarded, version pin) | `../docs/specs/plxt-cli.md` |
| Passthrough to `pipelex-agent` | `../docs/specs/mthds-agent-cli.md` (runner-aware section) |
| Hook-facing behavior (`codex-hook.ts`, the lint/fmt/validate pipeline, the `validate bundle` envelope the hook parses) | `../docs/specs/hook-lint-pipeline.md` |
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

**When citing a spec surface, note its conformance status.** Each verified surface in `docs/specs/` carries a `> Verified by:` line pointing at the `conformance/` test that exercises it (or an explicit `<!-- unverified: ... -->` marker). When a finding touches a surface, include its `> Verified by:` target (or note it's unverified) so the reviewer knows whether a test already guards it.

## Step 5 — Report

The report must be **self-contained** — readable by someone who has never seen this codebase. It may be handed off to a different SWE agent working in a different repo (e.g., the `docs` repo to update specs, the `conformance` repo to add tests, or the `skills` repo to adapt consumers). Include enough context for that agent to act without re-running this analysis.

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
- `docs/specs/mthds-agent-cli.md` — mthds-agent CLI (owned by mthds-js)
- `docs/specs/pipelex-mthds-protocol.md` — MTHDS Protocol wire surface (owned by pipelex + pipelex-api; implemented by the API runner)
- `docs/specs/plxt-cli.md` — plxt CLI (owned by vscode-pipelex; consumed via passthrough)
- `docs/specs/hook-lint-pipeline.md` — hook pipeline (owned by mthds-plugins; participated in by codex-hook.ts)
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

## Step 6 — Offer to Save the Report

After presenting the report, ask the user:

> "Save this report to `wip/`? (e.g., `wip/contract-check-v0.1.3-to-v0.2.0.md`)"

If the user agrees:

1. Create the `wip/` directory if it doesn't exist
2. Write the report as a markdown file named `wip/contract-check-<baseline>-to-<target>.md`
3. The saved report must include the full header block so that a different SWE agent working in a different repo (e.g., `docs`, `conformance`, `skills`, `vscode-pipelex`) can understand what was checked, what was found, and what needs resolution — without needing access to this repo or this conversation

## Notes

- **Specs and conformance are a linked pair.** If the resolution to a finding is to edit a spec in `docs/specs/`, the matching `conformance/` test must be updated in the same change, and `make check-spec-links` (run from the `conformance/` repo) must pass — it enforces the bidirectional `> Verified by:` ↔ `pytestmark = pytest.mark.spec(...)` links. A spec edit that renames a heading or documents a new surface without touching conformance will fail that gate. Remind the user of this whenever a finding points at a spec edit.
- The `mthds` interactive CLI does not have a spec yet (it's user-facing, not machine-facing). Flag notable changes for awareness but don't treat them as spec violations.
- The `mthds-agent` CLI spec and the MTHDS Protocol spec are the most critical, because AI agents, the `skills` plugin, and `pipelex-app` depend on their exact output/wire formats.
- When checking passthrough behavior, pay special attention to how arguments are constructed and forwarded — even small changes (extra flags, different ordering) can break downstream consumers.
- This skill detects discrepancies — it does not assign blame. The code might be wrong, the spec might be stale, or both might need updating. That's a human decision.
