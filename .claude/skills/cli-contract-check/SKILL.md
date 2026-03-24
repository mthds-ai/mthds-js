---
name: cli-contract-check
description: Detect CLI contract breakages between current code and a baseline (defaults to last release tag, but the user can specify any tag or commit). Compares CLI-related source files and changelog entries against the interface contracts in ../docs/contracts/. Use when the user says "check CLI contract", "contract review", "CLI breakage", "contract check", "did we break the contract", "check interfaces", "compare to vX.Y.Z", or before shipping/releasing a version that touches CLI code. Also trigger automatically before the /release skill runs, and proactively when you notice CLI-related file changes during a PR review.
---

# CLI Contract Check

Detects ruptures between the CLI interfaces implemented in this package and the contracts that document them. The contracts are the source of truth for what downstream consumers rely on, so any undocumented change is a potential breakage.

## Prerequisites: Locate the Contracts

The contracts live at `../docs/contracts/` (relative to the mthds-js repo root, i.e. the sibling `docs` repo). Before doing anything else:

1. Check that the directory `../docs/contracts/` exists.
2. Check that it contains at least `mthds-agent-cli.md` (owned by this repo).

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

Start the report with a summary table for quick scanning, then the detailed sections.

### Summary

```
| Category               | Count | Action needed? |
|------------------------|-------|----------------|
| Confirmed Breakages    | N     | Yes            |
| Undocumented Additions | N     | Yes            |
| Safe Changes           | N     | No             |
```

Follow the table with a one-line verdict, e.g.: "2 items require contract updates before release." or "All clear — no contract-visible changes."

If comparing against a non-default baseline, note it: "Baseline: `v0.1.3` (user-specified)"

---

### Confirmed Breakages

Changes that contradict what the contract specifies. These are the most urgent — something a consumer relies on has changed without the contract being updated.

### Undocumented Additions

New commands, options, or behaviors that work correctly but are not yet reflected in the contract. These need contract updates before release.

### Safe Changes

Internal-only changes and changes already documented in the contracts. List briefly for completeness.

### Recommendation

For each breakage or undocumented addition, recommend one of:
- **Update the contract** — if the code change is intentional
- **Revert the code change** — if the contract is correct and the code drifted
- **Discuss with the team** — if the right answer isn't clear

## Notes

- The `mthds` interactive CLI does not have a contract yet (it's user-facing, not machine-facing). Flag notable changes for awareness but don't treat them as contract violations.
- The `mthds-agent` CLI contract is the most critical one because AI agents and the `skills` plugin depend on its exact output format.
- When checking passthrough behavior, pay special attention to how arguments are constructed and forwarded — even small changes (extra flags, different ordering) can break downstream consumers.
