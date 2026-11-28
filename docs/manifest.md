# The manifest

`METHODS.toml` is defined by the standard, in `mthds/docs/spec/manifest-format.md`. This page says how this package reads it.

## The two readers

| Reader | Where | Reached by | An unknown key |
|---|---|---|---|
| `parseMethodsToml` | `src/package/manifest/parser.ts`, with its Zod schemas in `schema.ts` | `mthds package list` and `validate`, `mthds-agent package list` and `validate`, package discovery | refused, by `.strict()` |
| `validateManifest` | `src/package/manifest/validate.ts` | the GitHub and local resolvers, so every command that reads a repository: `install`, `publish`, `share` | ignored |

The parser stops at the first fault and returns the flat `ParsedManifest`. The validator collects every fault and returns the nested `MethodsManifest` the installer uses. `convert.ts` bridges the two shapes. A rule both readers apply is written once, in `schema.ts`, and each imports it. How `mthds_version` is split between them is in [versioning.md](./versioning.md#mthds_version-is-a-constraint-not-a-stamp).

Neither reader requires `[exports]`, which the manifest format makes optional, nor a `main_pipe` listed in it, since the format exports the main pipe by virtue of being `main_pipe`; a section that is present is checked by both.

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

## Result line and example inputs

```toml
[package]
address     = "github.com/acme/nda-review"
version     = "1.2.0"
description = "Review an NDA clause by clause against the company playbook"
main_pipe   = "review_nda"
result_line = "{{ output.clauses | length }} clauses reviewed"
examples    = ["examples/mutual-nda.json"]
```

`[package] result_line` is a Jinja2 template wording a finished run of the main pipe in one line, reading the main pipe's output as `output`, and `examples` lists files of the method's tree, each holding a complete set of example inputs for the main pipe, in the order a consumer offers them. Both readers carry them as written: `ParsedManifest.resultLine` and `examples`, `PackageSection.result_line` and `examples`, an empty `examples` array included, and `serializeManifestToToml` and the bridge write back each one the manifest declares.

Both readers check the rules a manifest can break on its own, written once as `presentationKeyFaults` in `schema.ts`:

- **Both keys require the manifest's own `main_pipe`.** A `result_line` without one breaks `result_line_without_main_pipe`, and a non-empty `examples` without one breaks `examples_without_main_pipe`. An empty `examples` array declares no example, as leaving the key out does.
- **A result line holds something.** An empty template, or one holding only white space, which would render to no line at all, breaks `result_line_invalid`.

Each rule carries the `method.package_invalid` reason the manifest format gives it, a `ManifestPackageReason` (`src/package/manifest/package-reason.ts`). The strict reader refuses the manifest for the first rule broken, a blank result line before a missing main pipe, and its `ManifestValidationError.reason` names that reason, so `mthds-agent package validate` and `package list` answer `method.package_invalid` with it, such as `{"reason": "result_line_without_main_pipe"}`, where every other refusal of the manifest answers `manifest_invalid`. The installer's validator collects every rule broken as a message among its errors.

The rest is the runtime's to judge, because it needs what a manifest alone does not hold: whether the template parses as Jinja2 and reads no free variable but `output`, which needs a template engine and is reported as `result_line_invalid`; whether each example names a file of the tree, which needs the tree and is reported as `method.resource_missing`; and whether each file holds a valid set of inputs for the main pipe, which needs the resolved library and is reported as `example_invalid`, the one member of `ManifestPackageReason` this package never raises. Rendering the line when a run succeeds, and offering the examples, are the runtime's as well. `mthds package list` and `validate` show both keys, and `mthds-agent package list` and `validate` answer `result_line` and `examples` in the manifest's JSON as written, leaving each out when the manifest does.
