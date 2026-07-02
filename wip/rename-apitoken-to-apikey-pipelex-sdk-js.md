# Handoff: rename `apiToken` → `apiKey` in `@pipelex/sdk` (`pipelex-sdk-js`)

Paste this as the prompt when working in `../pipelex-sdk-js`.

---

Rename the `PipelexApiClient` constructor option `apiToken` to `apiKey` across `pipelex-sdk-js` — source, tests, README, and CHANGELOG. This mirrors the same rename already shipped in `mthds-js` for `MthdsApiClient` (aligning the option name with the `*_API_KEY` env var it falls back to). This is a **breaking change** to the published `@pipelex/sdk` package; per the workspace's "no backward compatibility" principle there is no deprecation shim — just change it and note it in the changelog.

The env-var fallback here is `PIPELEX_API_KEY` (not `MTHDS_API_KEY`), so the rename makes the option name match the env var, same as on the `mthds-js` side.

## Why

`mthds-js`'s `MthdsApiClient` option was renamed `apiToken → apiKey`. For consistency across both our TS clients, `@pipelex/sdk`'s `PipelexApiClient` should use `apiKey` too. `mthds-js`'s `docs/run-lifecycle.md` no longer carries an inline `PipelexApiClient` example (those examples now live only with the SDK) — so update **this** repo's README example to `apiKey` when you rename.

## Exact edits

All occurrences of the `apiToken` identifier (baseline — re-grep to confirm before editing, line numbers may have drifted):

**`src/client.ts`**
- L81 doc comment: `/** API token (Bearer). Falls back to \`PIPELEX_API_KEY\`. ... */` → change wording to **`API key (Bearer)`**.
- L82: `apiToken?: string;` → `apiKey?: string;` (the `PipelexApiClientOptions` interface field)
- L144: `private readonly apiToken: string | undefined;` → `apiKey`
- L152: `this.apiToken = options.apiToken ?? process.env.PIPELEX_API_KEY;` → `this.apiKey = options.apiKey ?? process.env.PIPELEX_API_KEY;`
- L200–201 and L265–266: `if (this.apiToken) { headers["Authorization"] = \`Bearer ${this.apiToken}\`; }` → `apiKey` (two identical blocks)

**`README.md`**
- L25: `apiToken: process.env.PIPELEX_API_KEY,` → `apiKey: ...`
- L44: `new PipelexApiClient({ apiToken: process.env.PIPELEX_API_KEY });` → `apiKey`
- Scan the surrounding prose for any "API token" wording tied to this option and switch it to "API key".

**Tests** (`apiToken:` → `apiKey:` in each `new PipelexApiClient({ ... })`)
- `tests/client-lifecycle.test.ts` L6
- `tests/runs.test.ts` L16
- `tests/client.test.ts` L16, L54, L98
- `tests/product.test.ts` L8

## Changelog

The latest released entry is `## [v0.1.5]`; there is no `Unreleased` section yet. Add one at the top of `CHANGELOG.md`:

```markdown
## [Unreleased]

### Changed — `PipelexApiClient` constructor option renamed `apiToken` → `apiKey` (breaking)

The `PipelexApiClient` constructor option `apiToken` is renamed to `apiKey`, aligning the option name with the `PIPELEX_API_KEY` environment variable it falls back to (matching the same rename in `mthds`'s `MthdsApiClient`). Update `new PipelexApiClient({ apiToken })` call sites to `new PipelexApiClient({ apiKey })`. The wire (the `Authorization: Bearer` header) and the env-var fallback are unchanged.
```

Leave the `package.json` version bump to the release flow; just add the `Unreleased` section.

## Verify

`make check` does **not** run vitest (it's lint + format + typecheck + typecheck:test + build + depcruise). Run both:

```bash
make check
make test      # (== npm run test / vitest run)
```

Then confirm nothing lingers (only the CHANGELOG should still contain the word, intentionally naming the old option):

```bash
grep -rn "apiToken" --include="*.ts" --include="*.md" . | grep -v node_modules | grep -v dist
```

## Note on `mthds-js` (already done — no action needed here)

`mthds-js` is fully migrated: `MthdsApiClient` option, registry, tests, and docs (README / api-runner.md / architecture.md) all use `apiKey`, with a breaking CHANGELOG entry. `docs/run-lifecycle.md` now links to the `@pipelex/sdk` docs instead of embedding a `PipelexApiClient` code example. Prose mentions of `@pipelex/sdk`'s `PipelexApiClient` (as pointers) intentionally remain in `mthds-js` — those are cross-references, not examples.
