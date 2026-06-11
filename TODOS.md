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

> Note: the runner moved in the protocol⊥runners split — it is now `src/runners/pipelex/runner.ts` (paths below updated; the line numbers are pre-split approximations). The JSON-parse bugs (#1–#2) are still open and intentionally tracked here.

| # | File | Line | Command invoked | Reads stdout as | Risk under pipelex 0.29.x |
|---|---|---|---|---|---|
| 1 | `src/runners/pipelex/runner.ts` | 254-266 | `pipelex-agent check-model <ref> [--type <t>] [--format <f>]` | `JSON.parse` | **BROKEN** if caller omits `request.format`. `check-model` is markdown-default. |
| 2 | `src/runners/pipelex/runner.ts` | 269-280 | `pipelex-agent models [--type <t>...]` | `JSON.parse` | **BROKEN** unconditionally — never passes `--format json`. |
| 3 | `src/runners/pipelex/runner.ts` | 142-157 | `pipelex-agent inputs bundle <p> --pipe <c>` | `JSON.parse` | Safe (changelog: `inputs` stays JSON-default). |
| 4 | `src/runners/pipelex/runner.ts` | 228-235 | `pipelex-agent concept --spec <json>` | `JSON.parse` | Safe (changelog: `concept` stays JSON-default). |
| 5 | `src/runners/pipelex/runner.ts` | 238-251 | `pipelex-agent pipe --type <t> --spec <json>` | `JSON.parse` | Safe (changelog: `pipe` stays JSON-default). |
| 6 | `src/runners/pipelex/runner.ts` | 160-188 | `pipelex build output bundle ...` | `JSON.parse` | Likely safe — this is `pipelex build`, not the agent CLI's `run/validate/init`. **Phase-1 verifies**. |
| 7 | `src/runners/pipelex/runner.ts` | execute(), validate(), runPassthrough(), buildRunner() | streaming | n/a — `stdio: inherit` | Safe (no parsing). |
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

**Checkpoint 1 notes** (filled in 2026-05-23, pipelex 0.29.0 installed):

- **Result of 1.1**: Under **upstream-default** pipelex config (clean `HOME`), `pipelex-agent models --format json` and `pipelex-agent check-model gpt-4o --type llm --format json` produce **clean JSON to stdout** that parses correctly. Without `--format json`, both default to markdown (confirmed via direct invocation). Under **this user's local config**, a `DEBUG ... Telemetry is disabled ...` line leaks onto stdout and breaks `JSON.parse`.
- **Workaround for log-on-stdout if needed**: Not needed for end users. The DEBUG leak is **user-local**, caused by `~/.pipelex/pipelex_override.toml:6-7` setting `package_log_levels.pipelex = "DEBUG"`. Upstream default is `INFO`, and grepping `pipelex/cli/agent_cli/` finds **no `log.info(...)` calls in the agent CLI command paths** — so a stock install produces clean stdout. Pipelex exposes no env var for log target (verified by grepping `pipelex/tools/log/`). The "Known pipelex side issue" framing in the background section overstates the risk: it's a latent foot-gun for users who turn DEBUG on, not a default-config blocker. Phase 2 does **not** need a defensive parser; 2.4 can be dropped.
- **Result of 1.3 (buildOutput affected? Yes/No)**: **YES, broken** — and not in the way the audit table guessed. `pipelex build output bundle` does **not** emit JSON to stdout at all. It writes the JSON to a file (per `-o` default = "bundle's directory") and prints status text to stdout: `Using pipe '...' from bundle '...'` followed by `Generated output file: ...`. `JSON.parse(stdout)` at `pipelex-runner.ts:184` **cannot succeed** regardless of pipelex version. With `-o /dev/stdout` (or `-o -`), the JSON does land on stdout but is still bracketed by the same status lines, so a plain `JSON.parse(stdout)` still fails. This is a pre-existing bug, latent in the codebase; nobody has been hitting it because no caller exercises `buildOutput()` today.
- **Result of 1.4 (inputs/concept/pipe clean? Yes/No)**: **Mixed — audit table was wrong on two of three.**
  - **`inputs`**: ✅ Safe. Docstring on `bundle_cmd.py:40` and `_inputs_core.py` confirm "Outputs JSON to stdout on success, JSON to stderr on error". Stdout is clean JSON on success.
  - **`concept`**: ❌ **Broken**. Reading `pipelex/cli/agent_cli/commands/concept_cmd.py`: the command title literally says "structure concepts from JSON specs with **raw TOML output**", and the implementation does `print(toml_content, ...)` — raw TOML on stdout, not JSON. Verified by running it: stdout is `[concept.Foo]\ndescription = "..."` etc. Errors go to stderr as JSON via `agent_error()`. The current `JSON.parse(stdout) as ConceptResponse` (with response type `{success, concept_code, toml}`) **cannot succeed**.
  - **`pipe`**: ❌ **Broken** — same as `concept`. `pipe_cmd.py` docstring: "structure pipes from JSON specs with raw TOML output". Raw TOML on stdout. `JSON.parse(stdout) as PipeSpecResponse` cannot succeed.
  - Authoritative quote from `pipelex/cli/agent_cli/CLAUDE.md`: "`inputs`, `concept`, `pipe`, `fmt`, `lint`, `accept-gateway-terms` are **always JSON / raw passthrough** — they have neither `--format` nor `--error-format`. Their errors keep flowing through the ContextVar's JSON default." — meaning errors are JSON, but the **success payload format is per-command** (inputs=JSON, concept/pipe=TOML).
- **Additional invocation sites found in 1.5**:
  - `src/cli/commands/setup.ts:79` — `pipelex init` (stdio inherit, no parse) — safe.
  - `src/cli/commands/setup.ts:174` — `pipelex --version` (only `stdout.trim()`, not JSON) — safe.
  - `src/cli/commands/login.ts:28` — `pipelex login --no-logo` (stdio inherit) — safe.
  - `src/installer/runtime/spawn.ts:5` — `pipelex <args>` (stdio inherit) — safe.
  - `src/agent/passthrough.ts:136` — generic `spawnSync` (stdio inherit) — safe.
  - `src/agent/commands/pipelex-passthrough.ts:42` — `pipelex-agent` passthrough (stdio inherit) — safe; per scope decision, do not force `--format json`.
  - `src/agent/commands/codex-hook.ts:160` — `plxt` (not pipelex) — out of scope.
  - **Conclusion**: every `JSON.parse(stdout)` against `pipelex`/`pipelex-agent` lives inside `PipelexRunner` (rows 1-6 of the audit table). No surprises elsewhere.
- **Tests to update in Phase 2**:
  - `tests/unit/runners/registry.test.ts` — only covers the factory; no `PipelexRunner` method coverage exists.
  - Phase 2 should **add** a new file (e.g. `tests/unit/runners/pipelex-runner.test.ts`) that mocks `execFile`/`spawn` and asserts the argv passed to `pipelex-agent`/`pipelex` for each fixed method.
  - Phase 3 should re-run `tests/unit/installer/runtime/version-check.test.ts` — check whether it hardcodes `"0.28.0"` (grep didn't surface anywhere obvious, but Phase 3 should re-grep before editing).

**Decisions taken at Checkpoint 1:**
- **Fix scope expanded**. The original plan named rows #1 (`checkModel`) and #2 (`models`) plus a maybe-#6. Reality: rows **#1, #2, #4, #5, #6** are all broken. Specifically:
  - #1 `checkModel` — fix by defaulting `request.format ?? "json"` on the wire.
  - #2 `models` — fix by appending `--format json` unconditionally.
  - #4 `concept` — **needs design call** (see below).
  - #5 `pipeSpec` — **needs design call** (see below).
  - #6 `buildOutput` — **needs design call** (see below).
  - #3 `buildInputs` — confirmed safe; no change.
- **Workaround needed for stdout log noise**: **No.** Drop task 2.4 from Phase 2. The DEBUG-on-stdout case is only hit when a user has explicitly raised `package_log_levels.pipelex` to DEBUG in their local config; it does not affect default installs and is upstream's problem to fix (not blocking us).
- **Open design questions that must be resolved before touching `concept`/`pipe`/`buildOutput`** — these were not anticipated in the original plan, and the right answer affects both the runner's return contract and any caller code. Recommend pausing here and discussing with the user before editing:
  1. **`concept()` / `pipeSpec()` return shape**: pipelex emits **raw TOML** on stdout. The current TS types declare `{success, concept_code, toml}`. Options: (a) synthesize the wrapper in the runner — set `success: true`, parse the TOML to extract `concept_code`/`pipe_code`, store the raw TOML in `toml`; (b) change the runner contract to return raw TOML string and update callers (none in this repo today — verified via grep — but worth confirming for downstream consumers); (c) ask pipelex upstream to add `--format json` to these commands. Recommend (a) for minimal blast radius.
  2. **`buildOutput()` strategy**: options: (a) pass `-o <tmp-file>` and read the file back (mirrors `buildRunner()`'s approach in the same file); (b) keep stdout but strip the two status lines; (c) ask pipelex upstream to add a `--quiet` flag that suppresses the status lines. Recommend (a) — it's identical in spirit to `buildRunner()` which already does this for the Python output file, and avoids fragile stdout parsing.
  3. **Are `concept()`/`pipeSpec()`/`buildOutput()` actually exercised today?** **Yes** — there are live in-repo callers:
     - `src/agent/commands/api-commands.ts:58` → `runner.concept({ spec })` (under `mthds-agent api ...`).
     - `src/agent/commands/api-commands.ts:120` → `runner.pipeSpec({ pipe_type, spec })` (same command surface).
     - `src/cli/commands/build.ts:299` → `runner.buildOutput({ ... })` (under `mthds build output`).
     - When run against the **pipelex** runner (i.e. local CLI mode), each of these three call sites is silently broken on any pipelex version where the corresponding upstream behavior is in place (concept/pipe = TOML-since-introduction; buildOutput = file-write-since-introduction). The API runner path is unaffected. This is **not** a 0.29.x regression — these have been broken for some time, masked by users defaulting to the API runner. Deferring is not acceptable; the live callers will produce confusing parse errors.

## 2. Phase 2 — Fix JSON.parse bugs

Goal: make every JSON.parse site in `PipelexRunner` reliable against pipelex 0.29.x.

- [x] **2.1** `checkModel`: replaced conditional `--format` push with `args.push("--format", request.format ?? "json")`.
- [x] **2.2** `models`: added `args.push("--format", "json")` after the type-push loop.
- [x] **2.3** `buildOutput`: added `-o <tmpfile>` to args and switched from `JSON.parse(stdout)` to `JSON.parse(readFileSync(outPath, "utf-8"))`. Mirrors `buildRunner()` pattern.
- [x] **2.3b** `concept`: replaced `JSON.parse(stdout)` with synthesized `{success: true, concept_code: spec.concept_code, toml: stdout}`.
- [x] **2.3c** `pipeSpec`: replaced `JSON.parse(stdout)` with synthesized `{success: true, pipe_code: spec.pipe_code, pipe_type: request.pipe_type, toml: stdout}`.
- ~~**2.4**~~ Dropped — pipelex upstream fixed log routing to stderr (`pipelex/fix/Log-target`, shipping as 0.30.0). No defensive parser needed.
- [x] **2.5** Created `tests/unit/runners/pipelex-runner.test.ts` with 6 tests covering all five fixed methods.
- [x] **2.6** `make check` passes (674 tests, 0 failures). No `make agent-test` target exists in this repo.
- [x] **2.7** Build type-checks clean.

### CHECKPOINT 2 — DONE

**Checkpoint 2 notes** (filled in 2026-05-25):

- **Files edited**: `src/runners/pipelex/runner.ts` (5 method fixes, +21/-10 lines).
- **Test additions**: `tests/unit/runners/pipelex-runner.test.ts` (new, 6 tests: checkModel default format, checkModel preserve format, models format, concept wrapper, pipeSpec wrapper, buildOutput file read-back).
- **`make check` result**: 674 passed, 0 failed.
- **Defensive parser introduced?**: No — dropped (2.4). Pipelex upstream fix (0.30.0) routes logs to stderr; no stdout pollution for standard installs.
- **Upstream**: pipelex `fix/Log-target` branch carries the log-target fix + version 0.30.0. To be merged to `dev` and released.

**Recommended:** create an intermediate commit at this checkpoint with a focused message. The Phase-3 floor bump should be its own commit so the bisect story stays clean.

## 3. Phase 3 — Bump pipelex floor to `>=0.30.0`

Goal: raise the runtime check so users on older pipelex are told to upgrade.

- [x] **3.1** Skipped skill — done manually.
- [x] **3.2** `src/agent/binaries.ts:41`: `">=0.28.0"` → `">=0.30.0"`. Single constant (`PIPELEX_PKG`) feeds both `pipelex` and `pipelex-agent` entries.
- [x] **3.3** `grep -rn "0.28" src tests` — only match was `binaries.ts:41` (now updated). No other hardcoded floors.
- [x] **3.4** `CHANGELOG.md` updated with `## [Unreleased]` section covering both the JSON-parse fixes (Fixed) and the floor bump (Changed).
- [x] **3.5** `make check` passes (674 tests). Version-check tests in `tests/unit/installer/runtime/version-check.test.ts` use `BINARY_RECOVERY` dynamically — no changes needed.
- [x] **3.6** `make check` passes.

### CHECKPOINT 3 — DONE

**Checkpoint 3 notes** (filled in 2026-05-25):

- **Final version constraint**: `>=0.30.0`.
- **Other hardcoded floors found**: None — `binaries.ts:41` was the only match.
- **CHANGELOG.md entry**: Fixed (five JSON.parse paths) + Changed (floor bump to >=0.30.0 with breaking-change notes).
- **Final `make check` result**: 674 passed, 0 failed.
- **Outstanding follow-ups**:
  - Merge `pipelex/fix/Log-target` to `dev` and publish 0.30.0 to PyPI.
  - Merge `mthds-js/fix/Pipelex-output-changes` and publish to npm.
  - Then `mthds-plugins` can bump its `min_mthds_version` to whatever this release ships as.

## 4. Out of scope for this round (don't do, but track)

These were explicitly deferred. Capture them so they don't get lost.

- Surface `error_category`, `model`, `provider`, `retryable` from pipelex error envelopes through `agentError(...)` in `src/agent/output.ts`. Pipelex `v0.29.0` Fixed-section: *"Wrapped exceptions now surface the underlying inference error's classification."*
- Surface `RemoteConfigStaleWarning` from success envelopes (`warnings: [{type: "RemoteConfigStale", ...}]`).
- Plumb `--cost-report/--no-cost-report` through `mthds run`. Currently flows via passthrough to `pipelex run`, which is fine for `mthds-agent` but `mthds run` (the human CLI in `src/cli/commands/run.ts`) doesn't have a stub for it.
- Update error-hint registry `AGENT_ERROR_HINTS` in `src/agent/output.ts` for new pipelex error types: `GatewayUnknownModelError`, `RemoteConfigUnavailableError`, `LLMModelNotFoundError`, `ImgGenModelNotFoundError`, `ExtractModelNotFoundError`, `SearchModelNotFoundError`.
- Filter or remap `--format` vs `--graph-format` on `mthds-agent validate bundle` passthrough. Per user decision (2026-05-23), we keep pipelex defaults — users hit the rename directly. If users complain, revisit.
- **Confirmed not affected** (no action needed): `mthds-agent codex hook` validation stages (Stage 1 `plxt lint`, Stage 2 `plxt fmt`). Both are raw passthrough; the pipelex 0.29.0 markdown flip does not touch them. Listing here so the next reader doesn't re-derive it.
