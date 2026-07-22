# PR #97 review follow-ups (greptile threads on codex-config)

Deferred items from the review-agent triage of [PR #97](https://github.com/mthds-ai/mthds-js/pull/97). The two greptile P1s themselves were fixed in the PR (minimum-Codex-version check + hook-disabling keys escalated to hard errors); these are the companion changes that live outside this repo or must wait for the release to ship.

## 1. mthds-plugins docs & skills are stale about apply-config (cross-repo)

Reporter: found while verifying greptile's "Older Codex Hooks Stay Off" thread. Needs its own change in `mthds-plugins`.

- `docs/codex-vs-claude-hooks.md` still says: plugin-bundled hook loading "requires `[features] plugin_hooks = true`", "`apply-config` sets it", and "Plugin-bundled hook discovery requires Codex 0.130+". Reality since mthds v0.18.0: apply-config writes no hook flag (the key was removed in Codex 0.134), and the supported floor is Codex 0.141.0+ (`MIN_CODEX_VERSION` in mthds-js `src/agent/codex-version.ts`, checked best-effort at runtime).
- `mthds-codex/skills/mthds-install/SKILL.md` and `mthds-upgrade/SKILL.md` preambles tell the agent to "relay any `warnings` entries — those (e.g. read-only sandbox, hooks disabled) need a hand-fix". Hook-disabled states are now conflict-style hard errors from `apply-config` (exit 1, `ConfigError`), not warnings — the preamble flow description should distinguish: conflicts/disabled-keys → show the error verbatim, user hand-edits; warnings (read-only sandbox, `CODEX_VERSION_TOO_OLD`) → relay.

## 2. Conformance test for the new hard-error trigger (wait for npm release)

The workspace spec (`docs/specs/mthds-agent-cli.md` § `mthds-agent codex apply-config`) was updated in the same change as the code, with the new error trigger and warning rows marked `<!-- unverified -->`. Once mthds v0.18.0 is published to npm (the version the conformance suite installs), add to `conformance/tests/mthds_agent/test_agent_json.py`:

- `[features] hooks = false` in an isolated HOME → apply-config exits non-zero with `error_type: ConfigError`, config file untouched.
- A stub `codex` binary on PATH printing a version below 0.131 → apply-config exits non-zero (`CODEX_HOOKS_UNAVAILABLE` hard error); printing a version in [0.131, floor) → exit 0 with the `CODEX_VERSION_TOO_OLD` warning and `--check` non-zero.
- Optionally: the same states under `--check` and `--dry-run` → same verdict (mode consistency).

Then flip the spec's `<!-- unverified -->` markers to `> Verified by:` links per the spec/conformance pairing rules.

## 3. Pre-existing spec gaps found by /contract-check (docs repo follow-up)

Found while running the release contract-check against baseline v0.17.0 — all three predate PR #97 (they were already true at the baseline), so they were not fixed in it:

- **`inputs upload` missing from the spec.** `mthds-agent inputs upload <file>` shipped in v0.17.0 (API-runner-only, `POST /v1/upload`) but `docs/specs/mthds-agent-cli.md` § `mthds-agent inputs` lists only `bundle` / `pipe` / `method`.
- **`run start` missing from the spec.** `mthds-agent run start` (protocol `POST /v1/start`, API runner; `src/agent/commands/api-commands.ts` "run start" block) is absent from the spec's `run` subcommand table.
- **`codegen` stub missing from code.** The spec's stub-sync note (§ "Pipelex stub sync requirement") lists `codegen` in the canonical runner-aware command set, but neither `pipelex-commands.ts` nor `api-commands.ts` registers it — it works only via the catch-all passthrough and does not appear in `mthds-agent --help`. Either add the stub or drop it from the spec's canonical list.
