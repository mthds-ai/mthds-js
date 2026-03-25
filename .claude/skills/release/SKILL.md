---
name: release
description: Prepare a new release for the mthds-js project. Bumps version in package.json, syncs package-lock.json, updates CHANGELOG.md, manages the release/vX.Y.Z branch, runs checks, and commits. Use when the user says "release", "prepare a release", "bump version", "new version", or "cut a release".
---

# Release Workflow

Guides the user through preparing a new mthds-js release in 8 interactive steps. Every step requires explicit user confirmation before proceeding.

## Step 1 — Gather State

Read the following and present a summary:

1. Current version from `package.json` (`"version": "X.Y.Z"`)
2. Latest entry in `CHANGELOG.md`
3. Current git branch (`git branch --show-current`)
4. Working tree status (`git status --short`)

If the working tree is dirty, **warn the user** and ask whether to continue or abort.

## Step 2 — Determine Target Version

Calculate the three semver bump options from the current version:

- **Patch**: `X.Y.Z+1`
- **Minor**: `X.Y+1.0`
- **Major**: `X+1.0.0`

Present these options to the user using `AskUserQuestion`. If the current branch already looks like `release/vA.B.C` and the version in `package.json` was already bumped, offer a **"Keep current (A.B.C)"** option.

Store the chosen version as `TARGET_VERSION` (no `v` prefix, e.g. `0.1.3`).

## Step 3 — Branch Management

The release branch **must** be named `release/v{TARGET_VERSION}`.

- If already on the correct branch: inform the user and continue.
- If on `dev`, `main`, or another branch: confirm with the user, then create and switch to `release/v{TARGET_VERSION}`.
- If on a *different* release branch: warn the user and ask how to proceed.

## Step 4 — Update Version in package.json

Edit the `"version": "..."` line in `package.json` to `"version": "{TARGET_VERSION}"`.

- If the version already matches: inform the user and skip.
- Otherwise: use the Edit tool to make the change, then show the diff.

The version in package.json must **not** have a `v` prefix (e.g. `0.1.3`, not `v0.1.3`).

## Step 5 — Sync package-lock.json

After updating `package.json`, regenerate the lock file so it reflects `TARGET_VERSION`:

```bash
npm install --package-lock-only
```

This updates `package-lock.json` without modifying `node_modules`.

- **If the lock file was already in sync**: inform the user and continue.
- **On failure**: show the error and ask the user how to proceed.

## Step 6 — Update CHANGELOG.md

The changelog entry **must** match the existing format: `## [vX.Y.Z] -`

Check if `CHANGELOG.md` already contains a `## [v{TARGET_VERSION}] -` entry.

- **If missing**: run `git log main..HEAD --oneline` (or `git log --oneline -20` if on `main`) to review recent commits. Draft a changelog entry from those commits and propose it to the user for approval. Insert the approved entry at the top of the changelog (after the `# Changelog` heading) formatted as:

```markdown
## [v{TARGET_VERSION}] - {TODAY'S DATE in YYYY-MM-DD}

### Added

- Item one

### Changed

- Item two

### Fixed

- Item three
```

Use the appropriate subsections (Added, Changed, Fixed, Removed, Breaking Changes) based on the commits. Only include subsections that have content. The user may accept, edit, or rewrite the proposed entry.

- **If exists**: show the existing entry and ask the user whether to keep it or edit it.

## Step 6b — CLI Contract Check

Before running checks, verify that CLI interfaces haven't drifted from their contracts. Run the `/cli-contract-check` skill. If it reports any confirmed breakages or undocumented additions, warn the user and ask whether to continue the release or pause to address the findings first.

This step is especially important when the diff includes changes to `src/cli.ts`, `src/agent-cli.ts`, `src/agent/`, `src/cli/commands/`, or `src/runners/types.ts`.

## Step 7 — Run Checks

Run:

```bash
make check
```

This builds the project and runs the test suite.

- **On success**: report and continue.
- **On failure**: show the errors and ask the user how to proceed (fix issues, skip checks, or abort).

## Step 8 — Review & Commit

Present a full summary:

- Target version: `v{TARGET_VERSION}`
- Branch: `release/v{TARGET_VERSION}`
- Files changed: `package.json`, `package-lock.json`, `CHANGELOG.md`
- Changelog entry preview

Ask the user to confirm. On confirmation:

1. Stage **only** `package.json`, `package-lock.json`, and `CHANGELOG.md` — never use `git add .` or `git add -A`.
2. Commit with message: `Bump version to {TARGET_VERSION} and update changelog`
3. Show the commit result.

Then offer (but do not automatically execute):

- **Push** the branch to origin (`git push -u origin release/v{TARGET_VERSION}`)
- **Create a PR** to `main` using `gh pr create`

Wait for explicit user approval before pushing or creating a PR.

## Rules

- Never use `git add .` or `git add -A` — only stage `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- Never push or create PRs without explicit user approval.
- The `v` prefix appears in branch names and changelog headers, but **not** in `package.json`.
- Always use today's date for new changelog entries (format: `YYYY-MM-DD`).
- If any step fails or the user wants to abort, stop immediately — do not continue the workflow.
