---
name: release
description: >
  Cut a release of mthds-js, the TypeScript CLI and SDK published to npm as
  `mthds`: the release/vX.Y.Z worktree, the package.json bump and the
  package-lock.json that follows, the changelog entry, the contract check and
  the quality gates, one commit, and a pull request to main. Use when the user
  says "release", "cut a release", "bump version", "new version", "prepare a
  release", "make a release", "ship it", "create release branch", "promote dev
  to main", or any variation of shipping a new version of mthds-js. Changelog
  content passed inline ("/release Added the output-form descriptor") becomes
  the entry. The merge is landed by /ledger-land, never by this skill.
---

# Releasing mthds-js

The procedure is the workspace release play, [`docs/releasing.md`](../../../../docs/releasing.md) at the workspace root — `../docs/releasing.md` from this repo's own root, which resolves the same from the main checkout and from any worktree. Read it first, then run it with what follows. The repo key is `mthds-js`, the base is `dev`, and the pull request targets `main`, where `guard-branches.yml`'s `gate-main` job fails any head branch that is not a `release/vX.Y.Z` of this repository rather than a fork. That job is convention enforcement and says so in its own header, so read a red `gate-main` as a branch name to fix rather than as proof that no other branch can reach `main`; the status check the branch-protection ruleset requires is `quality-checks.yml`'s. The release worktree is `_mthds-js--release`, made with `wt add mthds-js release --branch release/vX.Y.Z`. The repo declares neither `.worktree.toml` nor `.worktreeinclude`, so `wt` resolves the base from `origin/dev` and provisions with the Makefile's `install` target (`npm install`), which is what creates the gitignored `node_modules/` every gate below runs out of.

## What ships

The merge to `main` publishes, from `.github/workflows/publish.yml`, which fires on the push to `main` (`on: push: branches: [main]`) rather than on the pull request:

- **The `mthds` package on npm**, published by the `publish` job with `npm publish --access public --provenance` over OIDC trusted publishing (`permissions: id-token: write`), so no long-lived npm token is involved. The job runs `npm ci` and `npm run build` first, and uploads `dist/` as an artifact for the job below.
- **The `vX.Y.Z` tag**, created in that same job with `git tag "v$VERSION"` and pushed. It is lightweight — there is no `git tag -a` here — so always pass `--tags` when reading tags: a bare `git describe` finds no annotated tag in this repo and dies.
- **The GitHub Release**, by the `github-release` job. Its notes are the changelog section for that version, sliced between `## [vX.Y.Z] - ` and the next `## [v…] - ` heading with blank lines dropped and leading whitespace stripped; when no such heading is found the step warns, sets the notes empty and exits 0, so the Release ships carrying the bare line `Release vX.Y.Z` instead of failing.

**Every step is guarded on `npm view "mthds@$VERSION"`**, and an already-published version makes the whole workflow a green no-op: no publish, no tag, no Release, and a successful run. A merge to `main` that carried no version bump therefore reports success and ships nothing, which is why the landing reads the registry and the tag rather than the run's colour:

```bash
gh run list --workflow=publish.yml --branch main --limit 3 --json conclusion,headSha,url  # the run whose headSha is the merge SHA: success
npm view mthds version                                                                    # the registry's answer: X.Y.Z
git fetch --tags --prune origin && git tag --list vX.Y.Z                                  # the tag
```

`gh release view vX.Y.Z` confirms the Release and the notes it took from the changelog.

## Version files and the lock

- **`package.json`** — the top-level `"version"`, without a `v` prefix, and the only place the release number is written. Nothing under `src/` restates it.
- **The lock** — `npm install --package-lock-only` after the bump. `package-lock.json` carries the number twice, as its own top-level `"version"` and again in the root package entry, and this form of the command rewrites the lockfile without touching `node_modules/`. If it fails, stop and report it rather than committing a stale lock.
- **`pnpm-lock.yaml`** is tracked as well, but a lockfileVersion 9 file records the root importer's dependencies and no package version of its own, so the bump leaves it alone.
- **Also stamped:** nothing. There is no version badge and no version literal in the README or under `docs/`.
- **The two version constants in `src/` are not this package's release number and never move for a release.** `MTHDS_STANDARD_VERSION` (`src/package/manifest/schema.ts`) and `MTHDS_PROTOCOL_VERSION` (`src/protocol/models.ts`) are copies of cuts made in the standard's repo; `docs/versioning.md` is the account of which is which.

## Gates

Run in the worktree, in this order, before the commit:

1. **`/contract-check`** — the repo's own skill, which compares the source behind the interfaces this package ships, implements and consumes against the specs in `../docs/specs/` (a tracked directory of the workspace meta-repo rather than a checkout of its own, which `_mthds-js--release` reaches by the same relative path the main checkout does). It writes no report: each actionable finding becomes a workspace ledger item owned by the repo that has to act, so carry the ids it prints into the release summary. A finding owned by `mthds-js` that the user chooses to fix now is fixed here and committed **before** the release commit, in its own commit, so the release commit stays the bump and the changelog — the convention `f915bf0` ("Commit a contract fix taken at release time before the release commit") records. The step matters most when the promoted range touches `src/cli.ts`, `src/agent-cli.ts`, `src/agent/`, `src/cli/commands/`, `src/runners/` or `src/protocol/`.
2. **`make all`** — `clean`, then `check`, then `test`: `npm run check` is eslint, `prettier --check`, `tsc --noEmit` over the sources and again over `tsconfig.test.json`, the build, and dependency-cruiser over `src`; `make test` is `npx vitest run`. This is exactly what `quality-checks.yml` runs on the pull request, so a red one here is a red required status there. **`make check` alone does not run the suite** — `check` and `test` are separate targets, and `make all` is the pair. Nothing in it rewrites a tracked file: a red `format:check` is cured with `npm run format`, and a red `depcruise` means an import crossed a boundary declared in `.dependency-cruiser.cjs`, where the import is what moves and never the rule.

## The release commit

`package.json`, `package-lock.json` and `CHANGELOG.md` — staged by name. Nothing else belongs in it: the gates rewrite no tracked file, `dist/` is gitignored, and a contract fix or a version-floor bump taken during the gates is its own earlier commit.

## CI on the release pull request

- **`guard-branches.yml`** (`gate-main`) — the head branch into `main` matches `^release/v[0-9]+\.[0-9]+\.[0-9]+$` and belongs to this repository rather than a fork.
- **`version-check.yml`** — fires on pull requests to `main` and to `release/v…`. Into `main` it requires `package.json`'s version to be **strictly greater** than the one on `main`; because the head is a `release/vX.Y.Z` branch it also requires the version to equal the `X.Y.Z` in that name.
- **`changelog-check.yml`** — for a head starting with `release/v`, `CHANGELOG.md` must carry a `## [vX.Y.Z] - ` heading for the version in the branch name. It asserts nothing about `[Unreleased]`; leaving none behind is the play's rule, not CI's.
- **`quality-checks.yml`** — `make install` then `make all` on every pull request. Its status check is the one the branch-protection ruleset requires before anything merges into `main`.
- **`protocol-corpus-parity.yml`** — on every pull request, checks out the sibling `mthds-python` and requires `tests/fixtures/protocol/` to be byte-identical apart from `README.md` and the generated `*.fixture.ts` twins. It prefers the sibling branch of the same name and falls back to `dev`, and `mthds-python` has no `release/vX.Y.Z` branch unless it is releasing at the same moment, so a release pull request is compared against `mthds-python@dev`. A red here means the corpus was recaptured on one side only; the cure is the recapture in both mirrors, never an edit on the release branch. The workflow file itself is a vendored copy of `conformance/tests/mthds/fixtures/protocol_corpus_parity_workflow.yml` and must not be edited in place.
- **`cla.yml`** — the CLA assistant, on `pull_request_target`, with maintainers allowlisted through `vars.CLA_ALLOWLIST`.

`publish.yml` is not among them: it fires on the push to `main`, so nothing on the pull request exercises the publish.

## Particulars

- **No pre-release form.** Both gates refuse one rather than skipping it: `gate-main` matches `^release/v[0-9]+\.[0-9]+\.[0-9]+$`, and `changelog-check.yml` enters on any `release/v` head and then fails outright when the name does not match that same form. Ship a plain `X.Y.Z`.
- **The changelog heading carries the `v`** — `## [vX.Y.Z] - YYYY-MM-DD`, which is what `changelog-check.yml` greps for and what `publish.yml` slices the Release notes out of. The file keeps an `## [Unreleased]` heading between releases; the release folds it into the new entry and leaves none behind, and the next change re-creates one.
- **Release pull requests are squash-merged**, so the branch's `Release vX.Y.Z` commit message never reaches `main` — what lands there is the pull request title with its number appended, which is why the title is worth getting right.
- **The back-merge is a merge commit.** `dev` carries `Merge main into dev after the vX.Y.Z release` after each release rather than a fast-forward; `/ledger-land` makes it, and the changelog is the one conflict it expects.
- **The runtime floors are a coordinated-release concern, not a release number.** `MIN_PLUGIN_VERSION` (`src/agent/plugin-version.ts`), `PIPELEX_PKG` and `PIPELEX_TOOLS_PKG`'s `version_constraint` (`src/agent/binaries.ts`) and `MIN_CODEX_VERSION` (`src/agent/codex-version.ts`) are what this `mthds-agent` release enforces at runtime; `/check-min-versions` reads them and `/bump-required-versions` moves them. `plugin-version.ts`'s own header instructs bumping `MIN_PLUGIN_VERSION` "each release alongside `min_mthds_version` in the plugin's `targets/defaults.toml`", so when this release is one half of a coordinated cut with `mthds-plugins`, make that edit before the release commit and in a commit of its own.
- **Consumers pin `mthds` with a caret, and a caret on a `0.x` version stops at the next minor.** Several repos in the workspace declare an `mthds` dependency of the form `^0.x.y` — `pipelex-sdk-js`, `mthds-form`, `pipelex-app` and `mthds-starter-js` — and a minor release satisfies none of them until each moves its own range. Read the list rather than trusting this one, because a new consumer arrives without touching this file: `grep -l '"mthds": "\^' [a-z]*/package.json` from the workspace root names them, the character class skipping the `_<repo>--<topic>` worktrees that would otherwise repeat their repo. Nothing arms those bumps automatically, so file one against each repo the grep names, alongside the release item.
