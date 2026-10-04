# Client identification (`User-Agent`)

Every request `MthdsApiClient` sends to an MTHDS runner or to the Pipelex hosted API carries a `User-Agent` header that says which program sent it. The hosted platform parses it into a client surface for product analytics and its access log, which is how it tells a run started from the `mthds` CLI apart from one started by an SDK script, the web app or a hand-written `curl`. The convention is shared by every first-party client and is fixed by the Pipelex workspace spec `docs/specs/client-identification.md`; this page describes how `mthds-js` implements it.

The header is self-declared and unauthenticated. It is analytics metadata only and never gates authorization, rate limits or entitlements. It never contains a secret, a user identifier, an email or a hostname.

## What the header contains

The value is a list of product tokens, outermost first: the program the user is actually using, then this library, then the runtime.

```
[<appInfo>] mthds-js/<version> <runtime>/<runtime-version> (<os>; <arch>)
```

For example, the library used on its own on Node:

```
mthds-js/0.26.0 node/22.4.0 (darwin; arm64)
```

- `mthds-js/<version>` is this package's own release number, read from the `MTHDS_JS_VERSION` constant in `src/version.ts`. A unit test (`tests/unit/version.test.ts`) fails the suite whenever that constant and `package.json` disagree, so the two cannot drift. A constant is used rather than a runtime read of `package.json` because consumers bundle this SDK (for example `pipelex-app` under Next.js), where resolving the manifest relative to the module does not work.
- The runtime token is `node/<process.versions.node>`, `bun/<version>` or `deno/<version>`, followed by the `(<os>; <arch>)` comment. When the runtime version cannot be read, the runtime token is omitted.
- **In a browser or a web worker, no `User-Agent` is set at all**, including an Electron renderer that also exposes `process.versions.node`. Browsers either ignore the header or turn the request into a CORS preflight the API refuses, so browser traffic is identified by the browser's own `User-Agent`.

The header is computed once, when the client is constructed, and every request helper in the client builds its headers through one private method, so no request path — protocol routes, `pipeIo` or `health` — can miss it.

Requests `mthds-js` sends to third parties keep their own `User-Agent`: the GitHub resolver used by `mthds install` still sends `mthds-cli` to GitHub, and the npm-registry version check is untouched.

## `appInfo`: naming your program

An integrator building on `MthdsApiClient` can put its own name in front of the SDK's tokens with the `appInfo` option, shaped like Stripe's:

```typescript
import { MthdsApiClient } from "mthds";

const client = new MthdsApiClient({
  apiKey: process.env.MTHDS_API_KEY,
  appInfo: { name: "acme-invoicer", version: "1.4.0", url: "https://acme.example", details: ["batch"] },
});
// User-Agent: acme-invoicer/1.4.0 (batch; +https://acme.example) mthds-js/0.26.0 node/22.4.0 (linux; x64)
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | An RFC 9110 `token` — letters, digits and ``!#$%&'*+-.^_`|~`` only; lowercase kebab-case by convention |
| `version` | no | A `token`, such as `1.4.0` |
| `url` | no | A URL, rendered in the comment as `+url`: visible ASCII with no whitespace, parenthesis, backslash or semicolon |
| `details` | no | Comment parameters, each a `token` or `token=value` (the value a token or `name/version`), rendered before `+url` |

It renders as `name/version (<details>; +url)`, dropping `/version` and the comment when they are empty. An empty `version`, `url` or `details` counts as absent, not as invalid. An invalid `name`, `version`, `url` or detail is refused at construction with a `TypeError` whose message names the field; a header that would exceed the spec's 512-character bound is refused with a `RangeError`. The client never silently drops or rewrites a value. The `AppInfo` type is exported from the package entry.

## The two CLIs

The binaries this package ships name themselves with the same option, using the rows the spec's token registry gives them:

| Binary | `User-Agent` sent to the API runner |
|---|---|
| `mthds` | `mthds-cli/<version> mthds-js/<version> node/… (…)` |
| `mthds-agent` | `mthds-agent/<version> mthds-js/<version> node/… (…)` |

`createRunner()` (`src/runners/registry.ts`) takes the calling binary as a required first argument (`"mthds-cli"` or `"mthds-agent"`), so a command cannot create an API runner without naming the program it runs in. A unit test in `tests/unit/runners/registry.test.ts` additionally checks that every call under `src/cli/` passes `mthds-cli` and every call under `src/agent/` or in `src/agent-cli.ts` passes `mthds-agent`.
