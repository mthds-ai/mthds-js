---
name: cli-contract-check
description: Detect CLI contract breakages between current code and a baseline (defaults to last release tag, but the user can specify any tag or commit). Compares CLI-related source files and changelog entries against the interface contracts in ../docs/contracts/. Use when the user says "check CLI contract", "contract review", "CLI breakage", "contract check", "did we break the contract", "check interfaces", "compare to vX.Y.Z", or before shipping/releasing a version that touches CLI code. Also trigger automatically before the /release skill runs, and proactively when you notice CLI-related file changes during a PR review.
---

# CLI Contract Check

Detects discrepancies between the CLI interfaces implemented in this package and the contracts that document them. A discrepancy means the code and the contract disagree — but this skill does NOT presume which side is wrong. The code may need fixing, the contract may need updating, or both may need changes. That judgment belongs to the human reviewing the report.

## Prerequisites: Locate the Contracts

The contracts live at `../docs/contracts/` (relative to the mthds-js repo root, i.e. the sibling `docs` repo). Before doing anything else:

1. Check that the directory `../docs/contracts/` exists.
2. Check that it contains at least `mthds-agent-cli.md` (owned by this repo).
3. Also check for `plxt-cli.md` and `hook-lint-pipeline.md` — these are required by Step 4.

If the directory is missing or does not contain the expected contract files, **stop immediately** and tell the user:

> The CLI contracts directory was not found at `../docs/contracts/`. You need access to the `docs` repo. Please contact the Pipelex staff to get access.

Do not proceed with the review if contracts are missing.

## Step 1 — Identify the Baseline

If the user specified a baseline (e.g., "compare to v0.1.3" or "check against abc1234"), use that directly.

Otherwise, default to the latest release tag:

```bash
git tag --sort=-v:refname | head -1
```

Confirm the chosen baseline with the user before proceeding: "Comparing against `<baseline>`. Continue?"

This matters because the user may want to compare against an older release to catch cumulative drift, or against a specific commit for a targeted review.

## Step 2 — Detect CLI-Related Changes

Run a diff between the baseline tag and HEAD, scoped to the files that define or affect CLI interfaces. These fall into two categories:

### Provided CLIs (owned by this package)

These files define the `mthds` and `mthds-agent` CLIs that downstream consumers call:

- `src/cli.ts` — main `mthds` CLI entry point (commands, options, arguments)
- `src/cli/commands/**` — individual command handlers
- `src/agent-cli.ts` — `mthds-agent` CLI entry point
- `src/agent/**` — agent command handlers, output protocol, passthrough logic
- `src/runners/types.ts` — runner interface and type definitions (affects CLI options)

### Consumed CLIs (called by this package)

These files define how this package invokes external binaries:

- `src/agent/passthrough.ts` — passthrough to `plxt` and `pipelex-agent`
- `src/agent/binaries.ts` — binary discovery, install, and version checks

### Changelog

- `CHANGELOG.md` — check if any entries since the last release mention CLI changes, new commands, removed commands, renamed options, or output format changes

Run:

```bash
git diff <baseline-tag> HEAD --name-only -- \
  src/cli.ts \
  src/cli/commands/ \
  src/agent-cli.ts \
  src/agent/ \
  src/runners/types.ts \
  CHANGELOG.md
```

If **no files changed**, report that no CLI-related changes were detected and stop.

If files changed, proceed to Step 3.

## Step 3 — Classify the Changes

For each changed file, get the actual diff:

```bash
git diff <baseline-tag> HEAD -- <file>
```

Classify each change into one of:

- **Contract-visible**: changes to command names, subcommands, arguments, options, output format, exit codes, error shapes, or passthrough behavior. These are things a consumer or contract would care about.
- **Internal-only**: refactors, logging, cosmetic changes, or internal implementation details that don't affect the external interface.

Also scan the CHANGELOG entries added since the baseline for any mention of:
- New commands or subcommands
- Removed or renamed commands
- Changed options or arguments
- Changed output format or error protocol
- Breaking changes

## Step 4 — Review Against Contracts

For each contract-visible change, read the relevant contract and compare:

| What changed | Contract to check |
|---|---|
| `mthds-agent` commands, options, output format | `../docs/contracts/mthds-agent-cli.md` |
| Passthrough to `plxt` (arguments, flags forwarded) | `../docs/contracts/plxt-cli.md` |
| Passthrough to `pipelex-agent` | `../docs/contracts/mthds-agent-cli.md` (runner-aware section) |
| Hook-facing behavior (lint/fmt/validate pipeline) | `../docs/contracts/hook-lint-pipeline.md` |
| `mthds` CLI (interactive) | No contract exists yet — flag new commands/options for the user's awareness but no contract comparison needed |

For each contract-visible change, determine:

1. **Is the change documented in the contract?** (the contract already describes the new behavior)
2. **Does the change contradict the contract?** (the code now does something the contract says it doesn't)
3. **Is the change absent from the contract?** (new behavior not yet documented)

## Step 5 — Report

The report must be **self-contained** — readable by someone who has never seen this codebase. It may be handed off to a different SWE agent working in a different repo (e.g., the `docs` repo to update contracts, or the `skills` repo to adapt consumers). Include enough context for that agent to act without re-running this analysis.

Start the report with a header block, then the summary table, then the detailed sections.

### Header Block

```markdown
# CLI Contract Check — mthds-js

**Date**: YYYY-MM-DD
**Repo**: mthds-js (npm: `mthds`)
**Branch**: <current branch>
**Baseline**: `<tag>` (user-specified | auto-detected)
**Target**: HEAD (`<commit short hash>`)

**Contracts checked**:
- `docs/contracts/mthds-agent-cli.md` — mthds-agent CLI (owned by mthds-js)
- `docs/contracts/plxt-cli.md` — plxt CLI (owned by vscode-pipelex)
- `docs/contracts/hook-lint-pipeline.md` — hook pipeline (owned by skills)
```

### Summary Table

```
| Category               | Count | Resolution needed? |
|------------------------|-------|--------------------|
| Discrepancies          | N     | Yes                |
| Unmatched additions    | N     | Yes                |
| Aligned changes        | N     | No                 |
```

Follow the table with a one-line verdict, e.g.: "3 discrepancies require resolution before release." or "All clear — code and contracts are aligned."

---

### Discrepancies

Places where the code and the contract disagree. For each discrepancy:

1. **What the code does** — describe the actual behavior with file path and line reference
2. **What the contract says** — quote or paraphrase the relevant contract section with file path and section reference
3. **What changed** — which side moved? Did the code change since the baseline? Was the contract recently updated? Or is it unclear?

Do NOT recommend which side should change. State the facts and let the reviewer decide. If there is obvious context that helps (e.g., the CHANGELOG explicitly labels something as an intentional breaking change), include it — but still don't prescribe the fix.

### Unmatched Additions

Behaviors present in only one side:
- **In code but not in contract**: new commands, options, or output fields that the contract doesn't mention
- **In contract but not in code**: documented commands or options that don't exist in the implementation

For each, state clearly which side has it and which side lacks it.

### Aligned Changes

Changes that are consistent between code and contract. List briefly for completeness.

---

## Step 6 — Offer to Save the Report

After presenting the report, ask the user:

> "Save this report to `wip/`? (e.g., `wip/cli-contract-check-v0.1.3-to-v0.2.0.md`)"

If the user agrees:

1. Create the `wip/` directory if it doesn't exist
2. Write the report as a markdown file named `wip/cli-contract-check-<baseline>-to-<target>.md`
3. The saved report must include the full header block so that a different SWE agent working in a different repo (e.g., `docs`, `skills`, `vscode-pipelex`) can understand what was checked, what was found, and what needs resolution — without needing access to this repo or this conversation

## Notes

- The `mthds` interactive CLI does not have a contract yet (it's user-facing, not machine-facing). Flag notable changes for awareness but don't treat them as contract violations.
- The `mthds-agent` CLI contract is the most critical one because AI agents and the `skills` plugin depend on its exact output format.
- When checking passthrough behavior, pay special attention to how arguments are constructed and forwarded — even small changes (extra flags, different ordering) can break downstream consumers.
- This skill detects discrepancies — it does not assign blame. The code might be wrong, the contract might be stale, or both might need updating. That's a human decision.
