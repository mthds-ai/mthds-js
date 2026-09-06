# Versioning

This package copies two version numbers that are cut elsewhere, and publishes one of its own. Which is which is the thing to get right before touching any of them.

| Number | Declared at | Cut by |
|---|---|---|
| **MTHDS standard version** — `MTHDS_STANDARD_VERSION` | `src/package/manifest/schema.ts` | `mthds/docs/spec/versioning.md` § "The Standard Version" |
| **MTHDS Protocol version** — `MTHDS_PROTOCOL_VERSION` | `src/protocol/models.ts` | `mthds/docs/spec/versioning.md` § "The Protocol Version" |
| This package's own release — `version` | `package.json` | this repo's `/release` skill |

The first two are **copies of a cut made in the standard's repo**, not numbers this repo decides. They move only when the specification moves them, and they move independently of each other: a release of the standard that leaves the HTTP runner contract alone leaves the protocol version exactly where it was. Neither has anything to do with `package.json`'s `version`, which is this npm package's own release number.

Each is declared in exactly one place, so following a cut is a single edit. Do not re-declare either constant, and do not derive one from the other.

## What the standard version governs here

The standard version is the version of the specification itself — its language, its native concept set, and its manifest, lock and crate formats. In this package it does two things:

- **It is what a manifest's `mthds_version` is evaluated against.** `satisfiesMthdsStandardVersion` (`src/package/manifest/schema.ts`) returns a three-way verdict: satisfied, unsatisfied, or malformed.
- **It is the floor `mthds package init` writes** into a new package's `METHODS.toml` (`>=<standard version>`), in both the CLI and the agent CLI.

### `mthds_version` is a constraint, not a stamp

A manifest's `mthds_version` declares which versions of the standard the package is compatible with, so it is checked by *evaluation* and never by equality — a package constraining `>=1.0.0` is satisfied by an implementation of `2.0.0`. (A library crate's `mthds_version` is the other thing: a stamp of the exact version the crate was normalized against. This package does not produce crates.)

**The shape check and the satisfaction check live in different places, deliberately:**

- `parser.ts` — the METHODS.toml *parser* — checks only that `mthds_version` is a well-formed constraint. A manifest targeting a standard version this implementation does not implement is still a manifest, and reading, editing and publishing it must keep working.
- `validate.ts` — the *validator* the installer's GitHub and local resolvers gate on — checks the shape and then evaluates it. An unsatisfied constraint is an error there, which makes the resolver skip the method with a reason. Refusing to install a package that says it is incompatible with us is the point.

## The constraint grammar

`mthds_version` and `[dependencies].version` share one grammar, defined in `mthds/docs/spec/manifest-format.md` § "Version Constraint Syntax". It is **not** npm's range syntax, and the three differences are exactly the ones npm's `semver` cannot read:

| MTHDS | npm | Handling |
|---|---|---|
| `,` separates AND-ed clauses | a space does | split, evaluate each clause, AND the verdicts |
| `==1.0.0` is exact match | spelled `=1.0.0` | rewrite the operator |
| `!=1.0.0` excludes a version | no negation at all | strip and invert the clause's verdict |

Everything else — `^`, `~`, `>=`, `<=`, `>`, `<`, a bare exact version, `*`, and the partial and wildcard forms `1`, `1.0`, `1.*`, `1.0.*` — npm reads natively and is delegated to it.

`src/package/semver.ts` is where that lives. `parseConstraint` returns a `VersionConstraint` (the AND of its clauses), not a `semver.Range`: `!=` has no `Range` to compile into. Treat the result as opaque and evaluate it with `versionSatisfies`, `selectMinimumVersion`, or `selectMinimumVersionForMultipleConstraints`. `isValidVersionConstraint` (`schema.ts`) is the regex that accepts the same grammar; the two are meant to agree, and a constraint that passes the regex must be one `parseConstraint` can evaluate.

## Following a cut

When the standard's repo cuts a new version:

1. Read `mthds/docs/spec/versioning.md` to learn which of the two numbers moved.
2. Edit the constant — one line, one file, per number.
3. Run the suite. The `mthds_version` tests in `tests/unit/package/manifest/validate.test.ts` are written relative to `MTHDS_STANDARD_VERSION` rather than against a literal, so they follow the constant instead of breaking on it.
4. Record it in `CHANGELOG.md`. A standard-version bump is user-visible: it changes what `mthds package init` writes and which manifests the installer accepts.
