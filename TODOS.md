# TODOS — adapt mthds-js to pipelex 0.29.x

This document is a working plan, designed to survive a cold-start handoff. Read this whole file before resuming.

## 0. Background — why we're doing this

Pipelex shipped two releases (`v0.29.0` on 2026-05-20, `v0.29.1` on 2026-05-21) that change CLI output formats and error reporting. mthds-js currently floors `pipelex` / `pipelex-agent` at `>=0.28.0` in `src/agent/binaries.ts:42`. We want to:

1. **Fix pre-existing JSON-parse bugs** in `PipelexRunner` where commands that default to markdown are read via `JSON.parse(stdout)` without ever passing `--format json`.
2. **Bump the floor to `>=0.29.1`** so we can rely on the new behavior and the 0.29.1 cost-report fix.

Scope confirmed with user (2026-05-23):
- ✅ Fix JSON-parse bugs.
- ✅ Bump floor to `>=0.29.1`.
- ❌ Do **not** force `--format json` in `mthds-agent` passthrough (keep pipelex defaults).
- ❌ Do not surface new error envelope fields (`error_category` etc) in this round — deferred.
- ❌ Do not surface `RemoteConfigStale` warning — deferred.
- ❌ Do not add `--cost-report` plumbing — deferred (pipelex handles it via passthrough).

### Relevant pipelex changelog excerpts (from `pipelex/CHANGELOG.md`)

- **v0.29.0** "Agent CLI `run` / `validate` / `init` default to markdown output, with independent success/error format options (breaking)." Crucially: *"matching `models` / `check-model` / `doctor`"* — meaning `models` and `check-model` **already** defaulted to markdown before v0.29.0. So our JSON.parse bugs there have been latent.
- **v0.29.0** "`pipelex-agent validate bundle` graph-format option renamed `--format` → `--graph-format` (breaking)." — passthrough impact only; users see this directly.
- **v0.29.0** Various new fields/types on the error envelope (`error_category`, `model`, `provider`, `retryable`) and `warnings: [{...}]` on success envelope (offline mode). Out of scope for this round.
- **v0.29.1** `pipelex run` cost table + new `--cost-report/--no-cost-report` flag.

### Affected mthds-js sites (audit, before any edits)

| # | File | Line | Command invoked | Reads stdout as | Risk under pipelex 0.29.x |
|---|---|---|---|---|---|
| 1 | `src/runners/pipelex-runner.ts` | 254-266 | `pipelex-agent check-model <ref> [--type <t>] [--format <f>]` | `JSON.parse` | **BROKEN** if caller omits `request.format`. `check-model` is markdown-default. |
| 2 | `src/runners/pipelex-runner.ts` | 269-280 | `pipelex-agent models [--type <t>...]` | `JSON.parse` | **BROKEN** unconditionally — never passes `--format json`. |
| 3 | `src/runners/pipelex-runner.ts` | 142-157 | `pipelex-agent inputs bundle <p> --pipe <c>` | `JSON.parse` | Safe (changelog: `inputs` stays JSON-default). |
| 4 | `src/runners/pipelex-runner.ts` | 228-235 | `pipelex-agent concept --spec <json>` | `JSON.parse` | Safe (changelog: `concept` stays JSON-default). |
| 5 | `src/runners/pipelex-runner.ts` | 238-251 | `pipelex-agent pipe --type <t> --spec <json>` | `JSON.parse` | Safe (changelog: `pipe` stays JSON-default). |
| 6 | `src/runners/pipelex-runner.ts` | 160-188 | `pipelex build output bundle ...` | `JSON.parse` | Likely safe — this is `pipelex build`, not the agent CLI's `run/validate/init`. **Phase-1 verifies**. |
| 7 | `src/runners/pipelex-runner.ts` | execute(), validate(), runPassthrough(), buildRunner() | streaming | n/a — `stdio: inherit` | Safe (no parsing). |
| 8 | `src/agent/commands/pipelex-passthrough.ts` | whole file | passthrough to `pipelex-agent` for `run / validate / init / models / check-model` | n/a — `stdio: inherit` | User-visible output flips to markdown. Per user decision: keep pipelex defaults; do nothing. |

### Known pipelex side issue (out of our scope, but worth flagging)

`pipelex/pipelex.toml:73` sets `console_log_target = "stdout"` upstream-default. That means a `log.debug(...)` from `pipelex/system/telemetry/telemetry_factory.py:77` ("Telemetry is disabled because posthog.mode is set to 'off'") prints to **stdout** on every `pipelex-agent` invocation in some configs, polluting JSON output. Observed locally on pipelex 0.29.0. This is an upstream bug — log routing must be `stderr` for any machine-output CLI. **If `--format json` alone doesn't yield parseable JSON in Phase 1**, this becomes a blocker and we need to either (a) file a pipelex bug + tactical-patch mthds-js to strip non-JSON prefix lines, or (b) work around via `PIPELEX_LOG_TARGET=stderr` env if pipelex honors one.

Phase 1 needs to determine which.

### Cross-repo coupling — mthds-plugins depends on this work

The `mthds-plugins` repo (`../mthds-plugins/TODOS.md`) has its own follow-up driven by the same pipelex 0.29.x flip:

- Its PostToolUse hook (`templates/hooks/validate-mthds.sh.j2`) is silently broken on 0.29.x because it parses validate-bundle stderr as JSON; stderr is markdown by default now. The plugin will add `--error-format json` to the hook invocation.
- Its `min_mthds_version` (in `targets/defaults.toml`) will be bumped to whatever this repo ships with the floor change.

**Sequence**: this repo (mthds-js) ships first — Phases 1-3 here, then a release tagged on npm. Only then can mthds-plugins bump its `min_mthds_version` and release. Do not bump `min_mthds_version` in mthds-plugins ahead of an npm-published mthds-agent version, or users will hit "version too old" on `mthds-agent bootstrap`.

## 1. Phase 1 — Verify & audit (read-only)

No code changes in this phase. Goal: lock in the assumptions so Phase 2 is mechanical.

- [ ] **1.1** Run `pipelex-agent models --format json` and `pipelex-agent check-model gpt-4o --type llm --format json` against a fresh shell (no inherited env). Capture stdout to a file, confirm `python3 -c "import json; json.load(open('out'))"` parses. Record outcome below in "Checkpoint 1 notes".
- [ ] **1.2** If 1.1 stdout contains the `DEBUG ... Telemetry is disabled ...` line, determine the minimal env/config to silence it. Try, in order: (a) `PIPELEX_LOG_CONSOLE_TARGET=stderr` (or whatever env name pipelex exposes — grep `pipelex/tools/log/log_config.py`), (b) `--log-level critical`, (c) any `--quiet` flag. Document the result.
- [ ] **1.3** Confirm `pipelex build output bundle <p> --pipe <c> --format schema` returns clean JSON (table row #6). If it doesn't, expand the fix to include `buildOutput()`.
- [ ] **1.4** Confirm `pipelex-agent inputs bundle <p> --pipe <c>`, `pipelex-agent concept --spec ...`, `pipelex-agent pipe --type ... --spec ...` still emit JSON on stdout (table rows #3-5). This is a sanity check — the changelog says they're unaffected, but verifying takes 1 minute.
- [ ] **1.5** Search the codebase for any other place that might construct a `pipelex-agent` invocation. Specifically grep for `"pipelex-agent"` and for `execFileAsync(`/`spawnSync(`/`spawn(` to catch helpers I might have missed.
- [ ] **1.6** Look at `tests/unit/runners/` and any e2e tests for what's exercised today. List which tests will need updating in Phase 2.

### CHECKPOINT 1 — STOP

Before moving to Phase 2, fill in the section below. **Do not start Phase 2 until this section is filled in and reviewed.**

**Checkpoint 1 notes** (fill in during execution):

- Result of 1.1 (parses ok / DEBUG noise present):
- Workaround for log-on-stdout if needed:
- Result of 1.3 (buildOutput affected? Yes/No):
- Result of 1.4 (inputs/concept/pipe clean? Yes/No):
- Additional invocation sites found in 1.5:
- Tests to update in Phase 2:

**Decisions taken at Checkpoint 1:**
- Fix scope (which of rows #1, #2, #6 from the audit table):
- Workaround needed for stdout log noise (yes/no, what):

## 2. Phase 2 — Fix JSON.parse bugs

Goal: make every JSON.parse site in `PipelexRunner` reliable against pipelex 0.29.x.

- [ ] **2.1** In `src/runners/pipelex-runner.ts:254-266` (`checkModel`), always append `--format json` if the caller didn't already pass `request.format`. Don't change the public type signature; just default the wire-level format to `"json"` when undefined.
- [ ] **2.2** In `src/runners/pipelex-runner.ts:269-280` (`models`), append `--format json` unconditionally (no caller-controllable `format` field on `ModelsRequest` today).
- [ ] **2.3** If Phase 1 found `buildOutput` is also affected, mirror the same fix.
- [ ] **2.4** If Phase 1 found stdout log noise still pollutes JSON even with `--format json`, add a defensive parser helper and route all `JSON.parse(stdout)` sites in `PipelexRunner` through it. Keep the helper **strict**: strip only complete log-format lines *before* the first `{` or `[`, and stop stripping the moment a candidate JSON open-brace is seen — never attempt to recover from JSON-with-embedded-noise mid-payload (that path silently eats real errors). Add a unit-test fixture for "stderr log line leaks before JSON payload" so the behavior is locked. Document the rationale in a single-line comment pointing back to this TODOS.md, and **file a pipelex upstream issue** linked from the comment.
- [ ] **2.5** Update or add unit tests in `tests/unit/runners/`. At minimum:
  - Mock `execFileAsync` and assert the argv passed to `pipelex-agent` includes `--format json` for `checkModel` (when caller omits `format`) and `models`.
  - If 2.4 was taken, add a unit test for the defensive parser with a fixture containing a leading log line.
- [ ] **2.6** Run `make agent-test`. Should be silent on success. Any failure → diagnose before proceeding.
- [ ] **2.7** Run `make check` to ensure the build still type-checks.

### CHECKPOINT 2 — STOP

Before moving to Phase 3, fill in below.

**Checkpoint 2 notes** (fill in during execution):

- Files edited and summary of each change:
- Test additions / updates:
- `make agent-test` result:
- `make check` result:
- Defensive parser introduced? (yes/no, why):
- Anything surprising worth flagging upstream to pipelex:

**Recommended:** create an intermediate commit at this checkpoint with a focused message. The Phase-3 floor bump should be its own commit so the bisect story stays clean.

## 3. Phase 3 — Bump pipelex floor to `>=0.29.1`

Goal: raise the runtime check so users on older pipelex are told to upgrade.

- [ ] **3.1** Consider invoking the project's `bump-required-versions` skill (it knows the conventions for this repo). Trigger phrasing: "bump min pipelex version to 0.29.1". If the skill is unavailable or the user prefers manual, see 3.2-3.4.
- [ ] **3.2** Edit `src/agent/binaries.ts:42`: change `PIPELEX_PKG.version_constraint` from `">=0.28.0"` to `">=0.29.1"`. This single constant covers both `pipelex` and `pipelex-agent` binary entries.
- [ ] **3.3** Grep the repo for any other place that hardcodes the floor (`grep -rn "0.28" src tests`). Update consistently.
- [ ] **3.4** Update `CHANGELOG.md` at the project root with a new `## [Unreleased]` (or next-version) section describing:
  - Fixed: JSON-parse bug in `PipelexRunner.checkModel` and `PipelexRunner.models` (pipelex-agent has defaulted these commands to markdown for some time; we now pass `--format json` explicitly).
  - Changed: pipelex/pipelex-agent floor bumped to `>=0.29.1`. Cite the breaking changes from pipelex `v0.29.0` that propagate through the passthrough and users will see directly: (a) agent CLI `run` / `validate` / `init` default to markdown — agents that scripted around the previous JSON-default must add `--format json`; (b) `pipelex-agent validate bundle --format <graph-format>` renamed to `--graph-format` — anyone using mthds-agent for graph generation must rename the flag.
- [ ] **3.5** Run `make agent-test` again to ensure the floor bump didn't trip anything (version-check unit tests live at `tests/unit/installer/runtime/version-check.test.ts`).
- [ ] **3.6** Run `make check`.
- [ ] **3.7** If the user is in a worktree dev setup, `make build && make agent-test` may also be needed before integration tests pick up the change (see project-root `CLAUDE.md` "internal-tools integration tests" note).

### CHECKPOINT 3 — STOP / ready to land

**Checkpoint 3 notes** (fill in during execution):

- Final version constraint set:
- Other hardcoded floors found and updated:
- `CHANGELOG.md` entry summary:
- Final `make agent-test` result:
- Final `make check` result:
- Outstanding follow-ups for a future session:

**Hand-off when stopping mid-phase:**
- Branch state (clean / dirty, which files):
- Commits created in this session:
- Next concrete step to resume:
- Any pipelex upstream issues filed (links):

## 4. Out of scope for this round (don't do, but track)

These were explicitly deferred. Capture them so they don't get lost.

- Surface `error_category`, `model`, `provider`, `retryable` from pipelex error envelopes through `agentError(...)` in `src/agent/output.ts`. Pipelex `v0.29.0` Fixed-section: *"Wrapped exceptions now surface the underlying inference error's classification."*
- Surface `RemoteConfigStaleWarning` from success envelopes (`warnings: [{type: "RemoteConfigStale", ...}]`).
- Plumb `--cost-report/--no-cost-report` through `mthds run`. Currently flows via passthrough to `pipelex run`, which is fine for `mthds-agent` but `mthds run` (the human CLI in `src/cli/commands/run.ts`) doesn't have a stub for it.
- Update error-hint registry `AGENT_ERROR_HINTS` in `src/agent/output.ts` for new pipelex error types: `GatewayUnknownModelError`, `RemoteConfigUnavailableError`, `LLMModelNotFoundError`, `ImgGenModelNotFoundError`, `ExtractModelNotFoundError`, `SearchModelNotFoundError`.
- Filter or remap `--format` vs `--graph-format` on `mthds-agent validate bundle` passthrough. Per user decision (2026-05-23), we keep pipelex defaults — users hit the rename directly. If users complain, revisit.
- **Confirmed not affected** (no action needed): `mthds-agent codex hook` validation stages (Stage 1 `plxt lint`, Stage 2 `plxt fmt`). Both are raw passthrough; the pipelex 0.29.0 markdown flip does not touch them. Listing here so the next reader doesn't re-derive it.
