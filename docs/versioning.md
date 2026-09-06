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

- `parser.ts` — the METHODS.toml *parser* — checks only that `mthds_version` is a well-formed constraint. A manifest targeting a standard version this implementation does not implement is still a manifest, and reading and editing it keeps working.
- `validate.ts` — the *validator* — checks the shape and then evaluates it. An unsatisfied constraint is an error there. Refusing to install a package that says it is incompatible with us is the point.

**Today that split does not reach as far as the commands.** `validate.ts` is called from the GitHub and local resolvers (`src/installer/resolver/github.ts`, `local.ts`), and those resolvers are shared by every command that reads a repository — `mthds install`, but also `mthds publish`, `mthds-agent publish` and `mthds-agent share`. A method whose `mthds_version` this implementation does not satisfy therefore lands in `resolved.skipped` for all of them, so it cannot be *published* either, not merely not installed. That is a wider refusal than the split above intends: publishing a package that targets a different standard version is a legitimate thing to do, and the resolver cannot currently tell "this manifest is malformed" from "this manifest is fine but addressed to another version of the standard". Separating those two verdicts at the resolver boundary is tracked as its own piece of work; until it lands, read the rule as *the parser is lenient, and every resolver-backed command is strict*.

**A refusal is reported, never silent.** Because the refusal is wider than the split intends, the one thing that must not happen is a caller left unaware of it — an agent that publishes half a repository and is told it published a repository will not go looking. So the skip list is read at both places it reaches a caller:

- `--method <name>` looks in `resolved.skipped` before reporting a name as unknown, and gives the reason the resolver produced. A method that exists, is spelled correctly and carries a valid manifest is never called "not found"; the available-methods list stays a correction for an actual typo.
- Every `mthds-agent` envelope that reads a repository carries `skipped_methods`, an array of `{ name, errors }` — on the success envelopes of `install`, `publish` and `share`, and on their errors too, since "no valid methods to publish" is the case where the reason matters most. It is always present, empty when nothing was refused, and reports the whole repository's skip list even under `--method`, because a skip is a property of the repository rather than of the selection.

`success: true` still means the command did what it could, not that the repository was whole; `skipped_methods` is the field that answers the second question, and a machine consumer has to read it. `src/installer/resolver/skipped.ts` holds both helpers so the six call sites cannot drift apart.

The interactive CLI already printed its skip report and keeps it; the share text still counts only the methods actually published, which is accurate — a refused method was never published, so counting it would overstate.

## The constraint grammar

`mthds_version` uses the constraint grammar defined in `mthds/docs/spec/manifest-format.md` § "Version Constraint Syntax". (The grammar also governs `[dependencies].version`, but this implementation has no dependencies to apply it to: `validate.ts` rejects a `[dependencies]` section outright — "Dependencies have been removed from the MTHDS standard" — and `dependency-resolver.ts` / `vcs-resolver.ts` are retained but reached by nothing outside their own tests. So `mthds_version` is the only live consumer here.) It is **not** npm's range syntax, and the three differences are exactly the ones npm's `semver` cannot read:

| MTHDS | npm | Handling |
|---|---|---|
| `,` separates AND-ed clauses | a space does | split, evaluate each clause, AND the verdicts |
| `==1.0.0` is exact match | spelled `=1.0.0` | rewrite the operator |
| `!=1.0.0` excludes a version | no negation at all | strip and invert the clause's verdict |

Everything else — `^`, `~`, `>=`, `<=`, `>`, `<`, a bare exact version, `*`, and the partial and wildcard forms `1`, `1.0`, `1.*`, `1.0.*` — npm reads natively and is delegated to it.

`src/package/semver.ts` is where that lives. `parseConstraint` returns a `VersionConstraint`, not a `semver.Range`: `!=` has no `Range` to compile into. Treat the result as opaque and evaluate it with `versionSatisfies`, `selectMinimumVersion`, or `selectMinimumVersionForMultipleConstraints`.

**The AND-ed clauses are recombined into one `semver.Range`, not evaluated one range at a time**, and that is load-bearing rather than tidy. npm's prerelease rule is a property of a whole comparator set: a prerelease satisfies a range only when some comparator *in that same range* names its `major.minor.patch`. Give each clause its own range and `">=1.0.0-beta.1, <2.0.0"` rejects `1.0.0-beta.1`, because the upper bound gets an eligibility check of its own and the lower bound's explicit opt-in is nowhere in it — while the equivalent npm form `">=1.0.0-beta.1 <2.0.0"` accepts it. Joining the included clauses with a space keeps them in one comparator set and makes the two forms agree. The `!=` clauses stay separate by necessity, so a prerelease can still slip past an exclusion (`"!=2.1.0"` does not exclude `2.1.0-rc.1`); the specification does not say what exclusion should mean for a prerelease, so this is left as npm reads it.

A constraint is also **bounded** — a length and a clause ceiling in `semver.ts` — because a manifest is fetched from an arbitrary repository and every clause retains a compiled range. Any constraint the specification can express is far below both limits.

`isValidVersionConstraint` (`schema.ts`) is the regex gate on the same grammar, and **the two acceptors are deliberately not identical**. The regex is looser in one direction: it admits a prerelease suffix on a partial version (`>=1.0-beta`, `1-alpha`), which npm's `Range` will not read. It is stricter in another: it rejects forms `parseConstraint` would accept from npm, such as the space-separated range `">=1.0.0 <2.0.0"` and a leading `v`. Callers gate on the regex first and then handle `parseConstraint`'s failure as the `malformed` verdict, so the gap is reported rather than thrown; `validate.ts` is the worked example.

## Following a cut

When the standard's repo cuts a new version:

1. Read `mthds/docs/spec/versioning.md` to learn which of the two numbers moved.
2. Edit the constant — one line, one file, per number.
3. Run the suite. The `mthds_version` tests in `tests/unit/package/manifest/validate.test.ts` are written relative to `MTHDS_STANDARD_VERSION` rather than against a literal, so they follow the constant instead of breaking on it — except the pre-cut cases, which are literals on purpose: they ask what became of the manifests already published against `1.0.0`, and that population does not move when the constant does.
4. Record it in `CHANGELOG.md`. A standard-version bump is user-visible: it changes what `mthds package init` writes and which manifests the installer accepts.

**A prerelease cut is not a one-line edit.** Under npm's rule a prerelease satisfies nothing that does not name it, so setting the constant to, say, `2.1.0-rc.1` makes *every* ordinary constraint unsatisfied — `>=1.0.0` and even `*` — and every method on every repository is refused. The suite fails loudly when you try it (the wildcard case is the one to read), so this cannot ship by accident, but the fix is a decision about what a prerelease standard version should mean to a manifest, not a second edit. Take it up before following such a cut.
