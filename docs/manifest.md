# The manifest

`METHODS.toml` is defined by the standard, in `mthds/docs/spec/manifest-format.md`. This page says how this package reads it.

## The two readers

| Reader | Where | Reached by | An unknown key |
|---|---|---|---|
| `parseMethodsToml` | `src/package/manifest/parser.ts`, with its Zod schemas in `schema.ts` | `mthds package list` and `validate`, `mthds-agent package list` and `validate`, package discovery | refused, by `.strict()` |
| `validateManifest` | `src/package/manifest/validate.ts` | the GitHub and local resolvers, so every command that reads a repository: `install`, `publish`, `share` | ignored |

The parser stops at the first fault and returns the flat `ParsedManifest`. The validator collects every fault and returns the nested `MethodsManifest` the installer uses. `convert.ts` bridges the two shapes. A rule both readers apply is written once, in `schema.ts`, and each imports it. How `mthds_version` is split between them is in [versioning.md](./versioning.md#mthds_version-is-a-constraint-not-a-stamp).

A new key of `[package]` therefore touches both readers, their two types, `serializeManifestToToml` and the bridge. Forgetting the schema refuses every manifest declaring the key, and forgetting the serializer or the bridge drops it silently.

## Categories

`[package] categories` declares the categories a method belongs to, as lowercase slugs:

```toml
[package]
name       = "nda_analyzer"
address    = "github.com/acme/legal-tools"
version    = "0.3.0"
categories = ["legal", "customer-support"]
```

- **The pattern is the whole check.** Each entry must match `CATEGORY_SLUG_RE`, `^[a-z0-9]+(-[a-z0-9]+)*$`, which both readers apply through `isValidCategory`. Without the `m` flag, JavaScript's `$` matches only at the very end of the value, so `"legal\n"` is refused. A value that is not an array of strings is refused too.
- **No list of values exists here.** The standard defines the field and leaves the values to each catalog, so neither reader compares an entry with any list. A repeated entry and a value this package does not know are never errors, and an empty array declares no category, as leaving the field out does.
- **This package carries them.** It has no use for categories beyond showing them, so `ParsedManifest.categories` and `PackageSection.categories` keep the list as the manifest writes it, its order, its repeats and an empty array included, and `serializeManifestToToml` writes it back. An install copies `METHODS.toml` byte for byte.
- **Where they show.** `mthds package list` and `mthds package validate` print a list that holds an entry. `mthds-agent package list` and `package validate` answer `categories` in the manifest's JSON as written, and leave the key out when the manifest does.
- **Nothing writes them for an author.** `mthds package init` and `mthds-agent package init` take no categories: an author adds the key by hand.
