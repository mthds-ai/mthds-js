# Deferred from the PR #98 review

Two findings from the SWE-agent review of [PR #98](https://github.com/mthds-ai/mthds-js/pull/98) that are **real but not that PR's**. Both were verified against the code; neither is a regression from the `/v1/build/*` files[] migration. They are parked here rather than fixed inline because each wants its own change, and one needs a human decision.

The PR's own findings — the single-quoted-TOML regex, the `codegen.lock` hard postcondition, the `error_domain` mistag, the silent `allow_signatures` drop, the loose valid-report types — were all fixed in the PR.

---

## 1. `build output --format` silently returns the wrong format on the pipelex runner

**Reported by:** cubic (P2), on `src/cli.ts:235`.
**Thread:** https://github.com/mthds-ai/mthds-js/pull/98 (unresolved, `src/cli.ts`)

`mthds build output pipe x.mthds --runner pipelex` returns **JSON** where this CLI's own contract says **schema**.

The mechanism: every pipelex build command takes the passthrough branch in `src/cli/commands/build.ts` (`if (isPipelexRunner(runner)) { await runner.buildPassthrough(...) }`), which never reaches the `format` normalization below it. And `extractPassthroughArgs` (`src/cli/commands/utils.ts:31-51`) rebuilds its argument list from **`process.argv`**, so a Commander _default_ — which was never typed on the command line — is invisible to it. The flag is simply not forwarded, and `pipelex build output` then applies its own default, which is `json`.

**Why it is not this PR's.** Both halves are already on `dev`. The `--format schema` default on `build output` (`cli.ts:263`/`:283`) predates the migration, and so does `extractPassthroughArgs`'s argv reconstruction. The only `--format` default the migration _added_ is `build inputs --format json` — which happens to match `pipelex build inputs`'s own default, so it changes nothing observable. The bug is real and pre-existing.

**Fix.** The tactical patch is to append the resolved default before each passthrough when the flag is absent:

```ts
const extra = rawArgs.some((a) => a === "--format" || a.startsWith("--format="))
  ? []
  : ["--format", format];
await runner.buildPassthrough("output", [...extractPassthroughArgs("build", 2), ...extra]);
```

The right fix is to stop reconstructing argv altogether and forward Commander's parsed options. That is a refactor of the passthrough machinery, which is why it did not ride a migration PR. **A test would spy on `buildPassthrough` and assert `--format schema` is forwarded for `build output pipe` with no explicit flag.**

---

## 2. `mthds-agent codegen types|check` is advertised ahead of the engine that serves it

**Reported by:** cubic (P2 on `src/agent/commands/pipelex-commands.ts:146`, P3 on `CLI.md:891`).
**Threads:** https://github.com/mthds-ai/mthds-js/pull/98 (unresolved, `src/agent/commands/pipelex-commands.ts` and `CLI.md`)

`src/agent/binaries.ts:41` sets `PIPELEX_PKG.version_constraint: ">=0.35.1"`. But **no published pipelex ships a `codegen` command** — the codegen CLI exists only in pipelex's unreleased tree (`git ls-tree -r v0.38.0 | grep agent_cli/commands/codegen` is empty, and 0.38.0 is the latest on PyPI). So `uv tool install --upgrade "pipelex>=0.35.1"` installs 0.38.0, sails past the floor check, and then `pipelex-agent codegen types` dies with `UnknownCommandError`.

**Why it is not this PR's.** `git log dev..feature/Codegen -- src/agent/commands/pipelex-commands.ts` shows only `9ac093c` — the pre-existing agent/codegen stub work that happens to ride the same branch. It is not part of the `/v1/build/*` migration (`9e19d99`).

**The decision a human owes.** This is a rollout question, not a code bug — the stubs were shipped ahead of the engine knowingly (`CLI.md:891` says as much). Two options:

- **(a) Leave it, bump the floor later.** Raise `PIPELEX_PKG.version_constraint` to the first pipelex that ships `codegen`, in the release that follows pipelex's codegen release. Simplest; leaves a broken command in the meantime.
- **(b) Gate the stubs now.** Add a `PIPELEX_CODEGEN_MIN` constant and have the two `codegen` stubs check against it, so a pre-codegen install yields the existing structured `InstallError` — with its `uv tool install --upgrade` hint — instead of a bare `UnknownCommandError`. Costs a few lines; turns a confusing failure into an actionable one.

**Also, whichever is chosen:** `CLI.md:891` is worded wrong either way. It says an _older_ pipelex-agent reports `UnknownCommandError`, but an install _below_ the `>=0.35.1` floor never reaches the binary at all — `src/agent/passthrough.ts:99-107` either auto-upgrades it or short-circuits with a structured `InstallError`. `UnknownCommandError` is what you get from an install _at or above_ the floor that still lacks the command — which today is every published version. Reword to say that.
