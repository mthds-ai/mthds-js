# Publishing to mthds.sh

`mthds publish` and `mthds-agent publish` list methods on [mthds.sh](https://mthds.sh) through the hub's registry route, `POST https://mthds.sh/api/v1/registry/methods`. They send one request per method, one after the other, and report what the route answered for each one. Publishing does not depend on telemetry or usage statistics: it works with `DO_NOT_TRACK` set, and with every other switch of [usage-statistics.md](usage-statistics.md).

The hub reads the method from GitHub, not from this machine: it lists what the default branch of a public repository holds. The CLIs send no file, no manifest and no token; they only name the method.

## The request

```json
{ "address": "acme/tools", "name": "scoring" }
```

- `address` is the repository, `owner/repo` or `github.com/owner/repo`. An address naming a subdirectory (`owner/repo/sub/dir`) is refused by the CLI before anything is read, since the hub only reads `methods/<name>/` at a repository's root.
- `name` is the method's `[package].name`, its directory under `methods/`.

A private repository is refused by the CLI before any request: the hub lists public repositories only, and the repository's name is never sent.

## The answers

The CLIs read every answer by its `outcome`, never by the HTTP status.

| `outcome` | Meaning | What the CLIs do |
| --- | --- | --- |
| `registered`, `updated`, `unchanged` | The hub lists the method, newly, with a new version or commit, or as it already was. The answer carries `method` (`address`, `name`, `version`, `commit_sha`, `url`) and `validation` (`queued`, `up_to_date` or `unavailable`). | Report the method as published, with its page (`method.url`). |
| `refused` | The hub will not list it: `repository_not_found`, `repository_not_public`, `repository_blocked`, `method_not_found` or `manifest_invalid`, with a `message` and the manifest's `errors`. | Report the reason and the errors. |
| `error` | No verdict: `error.code`, `error.message`, `error.retryable`, and for a `bad_request` its `issues`. | Report the error. A `rate_limited` error is waited out for its `retry_after_seconds` (up to a minute) and retried, up to three requests in all. |

Two codes are the CLI's own: `unreachable` when no answer came (a network failure or the thirty-second timeout), and `unexpected_response` when the answer is not one the route defines.

The address a method is listed under is the one in `method.address`, which can differ from the one sent (GitHub's own capitalisation of the owner, say). The CLIs show `method.url` and send `method.address` in the `method_publish` event they still send for each method listed, which ranks it on mthds.sh and follows the method-event switches of [usage-statistics.md](usage-statistics.md#method-events). For a `--local` publish that event carries only the address, name and version the hub answered with, never a field of the local manifest, which may hold edits not pushed yet.

## `mthds publish`

The human CLI sends the requests behind a spinner, then shows each method's answer and a summary. It exits 0 only when every selected method was listed, and 1 otherwise, so a script running it never mistakes a refusal for a publish.

With `--local <dir>`, it publishes each method by the address its `METHODS.toml` declares, since the hub reads GitHub. Before any request it checks each of those addresses as it checks one given on the command line: it must be a GitHub address naming a repository's root, and GitHub, asked with the same credentials as a resolve (`GITHUB_TOKEN` or the `gh` CLI), must answer that the repository is public. A private repository, one GitHub does not show (which a private one can be), or a failure to reach GitHub refuses the publish, so the hub never learns the name of a repository that is not public; when the hub lists a different version than the local copy, it says so, so that a person who has not pushed yet knows why the page shows the old one.

## `mthds-agent publish`

The agent CLI answers on stdout:

```json
{
  "success": true,
  "published_methods": ["scoring"],
  "address": "acme/tools",
  "skipped_methods": [],
  "registrations": [
    {
      "name": "scoring",
      "outcome": "registered",
      "method": {
        "address": "Acme/tools",
        "name": "scoring",
        "version": "1.0.0",
        "commit_sha": "8d39d1dca38a4de613c20e85fbaa05dd75024835",
        "url": "https://mthds.sh/methods/Acme/tools/scoring"
      },
      "validation": "queued"
    }
  ]
}
```

- `published_methods` names only the methods the route listed, for a publish by address; for `--local`, see below.
- `registrations` carries each method's answer whole, with its `name`, so an agent can tell a refusal from a publish method by method.
- When no method was listed, it fails with one problem whose `message` gives each method's answer, with `registrations` and `skipped_methods` beside it (`src/agent/problems.ts`, `registrationsProblem`): the problem every answer reads as when they agree, `method.not_found` naming the repository when every method is missing, `runtime.unavailable`, worth a retry, when every failure is one a retry can fix even if they differ, and `runtime.unexpected` otherwise.
- When some were listed and others not, it succeeds, and the others' answers are in `registrations`.

`mthds-agent publish --local <dir>` keeps its shipped contract for now: it registers nothing, answers `success: true` with `published_methods` naming the selected methods, `registrations: []`, and a `message` saying that nothing was registered and that the methods must be pushed and published by their GitHub address. So `published_methods` alone does not say that a method was listed: an empty `registrations` with that `message` is how a caller tells that nothing was registered.

## Testing against a fake hub

`MTHDS_HUB_URL` replaces `https://mthds.sh` for both CLIs. It accepts only a loopback `http` origin, such as `http://127.0.0.1:8787`; anything else is refused before any request, so a test can never point a publish at a real host. The end-to-end tests in `tests/e2e/publish-registry.test.ts` run both CLIs against such a server.
