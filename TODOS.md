# TODOS — mthds-js work follow-up from mthds-plugins Phase 1

This is the cross-repo handoff brief for two mthds-js changes. Originally framed as Phase 2 items in `mthds-plugins/TODOS.md` (2G and 2D). Read that file for the full context on the Codex hook overhaul shipping (wip) in mthds-plugins 0.9.0 (2026-04-28).

Quick state: Codex 0.124.0+ now emits `PostToolUse(apply_patch)` hook payloads. mthds-plugins 0.9.0 retires `bin/install-codex.sh` and the bash hook script entirely; the validation runtime lives in mthds-agent now.

## Status

- **2G — `mthds-agent codex install-hook` rewrite + new `mthds-agent codex hook` runtime.** ✅ DONE in mthds-js 0.5.0 (2026-04-28). Final shape diverges slightly from the original brief — see "What actually shipped" below.
- **2D — `mthds-agent validate bundle` offline mode.** Still pending. Stage 3 in the Codex hook stays disabled until this lands.

---

## What actually shipped (2G)

**`mthds-agent codex install-hook` (rewritten)** — `src/agent/commands/codex.ts`
- Writes `hooks.PostToolUse[]` with `matcher: "apply_patch"` and `command: "mthds-agent codex hook"` (PATH-resolved at hook-fire time, not a script path).
- Migrates legacy `Stop` entries (pre-0.5.0 mthds-agent) AND legacy `PostToolUse(apply_patch)` entries that pointed at the old `~/.codex/hooks/codex-validate-mthds.sh` (mthds-plugins WIP 0.9.0 install-codex.sh shape).
- Idempotent — `entryIsCurrent` checks for the new shape specifically; legacy entries are removed and replaced.
- Status outputs unchanged: `INSTALLED_NEW_FILE` / `MERGED` / `ALREADY_INSTALLED`.

**`mthds-agent codex hook` (new runtime)** — `src/agent/commands/codex-hook.ts`
- Reads PostToolUse JSON on stdin, parses `tool_input.command` for `*** Update File: / *** Add File: / *** Move to:` headers (same shape the bash hook used).
- Runs `plxt lint --quiet` (block on failure) + `plxt fmt` (block on failure) for each touched `.mthds` file.
- Stage 3 (`mthds-agent validate bundle`) stays disabled — see 2D below.
- Emits Codex hook block protocol `{"decision":"block","reason":"..."}` on stdout when validation fails; silent pass otherwise.
- Exposed for testing via `runCodexHook(deps)` with injected `readStdin`/`fileExists`/`hasPlxt`/`runPlxt`/`emit` — pure helpers (`parseMthdsFiles`, `formatLintError`, etc.) covered separately.

**Differences from the original brief**
- Env-check is **not** bundled in the npm package. It stays in mthds-plugins (`bin/mthds-env-check`) — Codex skill preambles glob it from the plugin's per-version cache directory (`$CODEX_HOME/plugins/cache/*/mthds/*/bin/mthds-env-check`). Reasoning: env-check's job is "is mthds-agent installed?" — bundling it inside mthds-agent makes it useless for that check before the agent is installed.
- Hook script is **not** bundled either. Hook validation runs through `mthds-agent codex hook` (PATH-resolved), so there's no script to copy. mthds-plugins deletes the bash script entirely.
- Net result: `bin/install-codex.sh` in mthds-plugins disappeared entirely. Install line is now `npm install -g mthds && mthds-agent bootstrap && mthds-agent codex install-hook && codex plugin marketplace add mthds-ai/mthds-plugins`.

**Tests** — `tests/unit/agent/codex.test.ts` (rewritten — covers fresh install, idempotency, coexistence with unrelated entries, legacy-Stop migration, legacy-PostToolUse migration, and validation failures) + `tests/unit/agent/codex-hook.test.ts` (new — covers pure helpers and the dependency-injected runtime, including silent-pass paths, plxt-missing block, lint/fmt failure modes, and multi-file aggregation). End-to-end install regression test lives at `internal-tools/tests/test-nelly-plugin-install.sh` (PHASE=B).

---

## 2G — `mthds-agent codex install-hook` should write `PostToolUse(apply_patch)`

**Status: ✅ DONE in mthds-js 0.5.0.** Original brief retained below for reference.

### Why

`bin/install-codex.sh` in mthds-plugins used to delegate the `~/.codex/hooks.json` JSON merge to `mthds-agent codex install-hook` (shipped in mthds-agent 0.4.1). After Phase 1 switched the script to PostToolUse, calling the existing `install-hook` would silently regress: it would register a `Stop` entry pointing at a script that expects `PostToolUse(apply_patch)` payload, so the hook would never effectively fire (Stop has no `tool_input.command`).

To avoid the regression, mthds-plugins 0.9.0 inlines its own JSON merge inside `bin/install-codex.sh:merge_post_tool_use_hook`. It works, but it duplicates logic that belongs in mthds-agent. Once 2G lands, that ~70-line node block in install-codex.sh can be deleted and `bin/install-codex.sh` collapses to a thin wrapper (or disappears entirely if 2G also bundles the script + env-check).

### What to do

In `src/agent/commands/codex.ts`:

1. **Switch the entry shape from `Stop` to `PostToolUse(apply_patch)`.** Today (lines 55-65, 153-170) the file hardcodes `hooks.Stop[]` with no matcher. Target shape:

   ```jsonc
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "apply_patch",
           "hooks": [
             { "type": "command", "command": "~/.codex/hooks/codex-validate-mthds.sh", "timeout": 30 }
           ]
         }
       ]
     }
   }
   ```

   The matcher is `apply_patch` (canonical name in `codex-rs/core/src/tools/hook_names.rs:34-39`). `Write` and `Edit` are accepted as compatibility aliases but the canonical name is the safer choice.

2. **Migrate legacy `Stop` entries** that pointed at our script. Pre-0.9.0 installs left a stale `Stop` hook in `~/.codex/hooks.json`. When merging the new `PostToolUse` entry, also strip any `hooks.Stop[]` item whose `hooks[].command` contains `codex-validate-mthds`. Drop `hooks.Stop` entirely if it becomes empty. Keeping the stale entry would fork a no-op process every Codex turn.

3. **Stretch (recommended):** also bundle the hook script + env-check binary in the npm package and copy them into `~/.codex/hooks/` and `~/.codex/bin/` from `install-hook`. That eliminates `bin/install-codex.sh` in mthds-plugins entirely.
   - `package.json` currently ships only `dist/`. Either copy `assets/` into `dist/` during the `tsc` build (postbuild script) or extend `files: ["dist/", "assets/"]`.
   - The hook script source of truth is `mthds-plugins/templates/hooks/codex-validate-mthds.sh.j2`. The rendered output is `mthds-plugins/mthds-codex/hooks/codex-validate-mthds.sh`. Since that's a Jinja2-rendered file with `{{ plxt_install_cmd }}` substitution, mthds-agent can either: (a) ship its own copy with the install command rendered for the npm install path, or (b) ship the rendered prod variant verbatim and accept it points users to `uv tool install pipelex-tools` on lint-tool errors.
   - The env-check binary source of truth is `mthds-plugins/bin/mthds-env-check`. Static script, can be copied as-is.

### Reference: working node merge logic to mirror

mthds-plugins 0.9.0 inlines a self-contained version of the merge in `bin/install-codex.sh:merge_post_tool_use_hook` (search for `MARKER = "codex-validate-mthds"`). The shape of `entryMentionsMthds`, the `hooks.PostToolUse` initialization, the legacy `Stop` cleanup, and the atomic write-then-rename are all directly portable to TypeScript. The current `agentCodexInstallHook` in `src/agent/commands/codex.ts:83-184` already has all the JSON validation scaffolding — you mostly need to swap the entry shape and add the Stop-cleanup branch.

### Tests

The existing tests at `mthds-js/tests/...` (look for `codex.test.ts` or similar) need to be updated to assert the new PostToolUse shape. Mirror the four cases mthds-plugins added in `tests/unit/test_install_codex_version_ge.py:TestMergePostToolUseHook`:

- creates fresh hooks.json with PostToolUse(apply_patch) entry
- second invocation is a no-op (idempotent)
- legacy Stop entry pointing at our script is removed
- unrelated PreToolUse / Stop entries for other tools are preserved

### Version + coordination

- Bump `mthds` npm version (suggest 0.5.0 — breaking shape change to a public command's output).
- Bump `min_mthds_version` in `mthds-plugins/targets/defaults.toml` and `MIN_MTHDS_VERSION` in `mthds-plugins/bin/install-codex.sh` to the new version.
- Once shipped, mthds-plugins can replace its inline merge with a call back to `mthds-agent codex install-hook`. If the stretch goal landed, mthds-plugins can delete `bin/install-codex.sh` and the install line collapses to:

  ```bash
  npm install -g mthds && mthds-agent bootstrap && codex plugin marketplace add mthds-ai/mthds-plugins
  ```

  (The `/plugins` step inside Codex remains until upstream ships a one-shot CLI install — Phase 2C in mthds-plugins/TODOS.md.)

---

## 2D — `mthds-agent validate bundle` offline mode

### Why

The Codex hook script (`mthds-plugins/templates/hooks/codex-validate-mthds.sh.j2`) currently runs only Stages 1 + 2 (`plxt lint`, `plxt fmt`). Stage 3 (`mthds-agent validate bundle`) is disabled because the command eagerly fetches `pipelex_remote_config_08.json` from S3 on startup, and the Codex sandbox blocks that network call — the command hangs until timeout.

Validation itself is local: the remote config is not actually needed for structural checks (pipe shape, concept references, type alignment). The fix is to make the remote fetch lazy or skippable.

### What to do

Find the call site in `mthds-agent` that fetches `pipelex_remote_config_08.json` during bundle validation. Two reasonable shapes for the fix:

- **Lazy fetch:** only fetch the remote config when a code path actually needs it (e.g., model resolution for dry-run). Pure structural validation should never trigger it.
- **Skip-on-failure with timeout:** if the fetch errors or times out within ~1s, fall back to bundled defaults and log a one-line warning. Better DX than hanging.

Lazy is the cleaner answer — match what `plxt` did in vscode-pipelex PR #38 (lazy `reqwest` client init only when lint encounters http/https schema sources).

### Tests

Add a test that runs `mthds-agent validate bundle <fixture>` with network access blocked (e.g., via a `NO_NETWORK=1` env var, or by setting an unreachable proxy) and asserts the command completes within 5s with a clean validation result for a known-good bundle.

### Coordination

- Bump `min_mthds_version` in `mthds-plugins/targets/defaults.toml` to require the new mthds-agent.
- In `mthds-plugins/templates/hooks/codex-validate-mthds.sh.j2`, replace the Stage 3 placeholder (currently `true # disabled`) with the same Stage 3 block as `templates/hooks/validate-mthds.sh.j2` (Claude variant). Verify in a Codex session that Stage 3 completes without hanging.

---

## Out of scope

- **Codex one-shot CLI install** (`codex plugin install <repo>`): tracked in `mthds-plugins/TODOS.md` Phase 2C, blocked on openai/codex.
- **Plugin-bundled hooks** (auto-loading `hooks` from `plugin.json`): tracked in `mthds-plugins/TODOS.md` Phase 2A, blocked on openai/codex (`RawPluginManifest` deserializer in `codex-rs/core-plugins/src/manifest.rs:11-30` lacks the `hooks` field).
- **Claude Code hook**: no changes needed — Claude already auto-loads `hooks/hooks.json` from the plugin manifest.

---

## Pointers

- mthds-plugins Phase 1 plan + verification matrix: `mthds-plugins/TODOS.md`
- Codex vs Claude hook comparison + upstream issue tracking: `mthds-plugins/docs/codex-vs-claude-hooks.md`
- Reference apply_patch payload shape: `~/repos/OpenSource/codex/codex-rs/core/src/tools/handlers/apply_patch.rs:317-339`
- Reference hook tool name + matcher aliases: `~/repos/OpenSource/codex/codex-rs/core/src/tools/hook_names.rs:34-39`
- `codex_hooks` feature flag (now `Stage::Stable, default_enabled: true` — no longer needed in user config): `~/repos/OpenSource/codex/codex-rs/features/src/lib.rs:765-770`
