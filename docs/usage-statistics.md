# Usage statistics

The `mthds` and `mthds-agent` CLIs send anonymous usage statistics: one `command_completed` event per command, saying which command ran and how it ended. They follow the usage-statistics contract every Pipelex and MTHDS tool shares (pipelex, plxt, the VS Code extension and these CLIs), whose canonical text is [`conformance/specs/usage-statistics.md`](https://github.com/Pipelex/conformance/blob/main/specs/usage-statistics.md) with its machine-readable schema `usage-statistics.json`. This package carries a byte-identical copy of that schema in `tests/fixtures/usage-statistics.json`, and its tests check every event it builds against it. The page the notice links to, [docs.pipelex.com/latest/setup/usage-statistics](https://docs.pipelex.com/latest/setup/usage-statistics/), describes the statistics for every tool; this page says how these CLIs carry them out.

Separately, `mthds install` and `mthds publish` send the `method_install` and `method_publish` events that rank methods on mthds.sh. Those go to a different place and follow fewer switches; see [Method events](#method-events) below.

## The notice

The first command that sends statistics on a machine prints this notice on stderr, once:

> Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, and the country your IP address maps to; the address itself is never stored. It never collects your methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run `mthds telemetry disable` or set DO_NOT_TRACK=1. Details: https://docs.pipelex.com/latest/setup/usage-statistics/

The notice is recorded in `~/.mthds/usage-stats/notice-v1`, which every tool reads, so a notice another tool already printed is not printed again. It is printed only while statistics are on.

`mthds` prints it on any command that sends an event. `mthds-agent` is read by agents and by hooks that parse its output, so its native commands (`install`, `publish`, `config`, `package`, `doctor` and the rest) never print it. Only the commands it runs on a runner may, and only when their errors are not JSON: `init`, `validate`, `run`, `models`, `check-model`, `inputs` and `codegen` on the pipelex runner, and on the API runner only `validate bundle` and `validate pipe`, whose errors are Markdown. A `--format json` or `--error-format json` invocation never sees it.

## What is sent

Every event carries the contract's common properties: the schema version, `tool: "mthds"`, the CLI's version, the `surface` (`mthds` or `mthds-agent`), the `host` when a program running the CLI declared itself through `PIPELEX_USAGE_STATS_HOST` (`cocode`, `mthds-agent`, or `other` for any other value), whether this command created the installation identifier (`id_new`), the operating system and processor families, the Node major version (`node-22`), whether it ran in CI or in a container, whether the machine is marked as one of the team's (`internal`), and the notice version the machine has seen.

`command_completed` adds:

- `command`: the command's path, such as `config list` or `run pipe`, from the contract's list for the surface; any command the list does not name is sent as `other`. Arguments, option values, paths and method names are never sent.
- `outcome`: `succeeded`, `failed` or `cancelled` (interrupted with Ctrl-C; on `mthds-agent`, a tool it runs that is interrupted, or that handles Ctrl-C and exits with status 130, cancels the command too).
- `error_domain` on a failure, when the CLI can say who can fix it: `input` for a command line that did not parse or an agent error in the argument, validation or package domain; `config` for the config and binary domains; `runtime` for the runner and pipeline domains. Install and file errors send none.
- `duration_ms`, and `hosted` on a `run` command given `--hosted` (true) or `--local` (false).

Each event is sent under the installation identifier, a random UUID in `~/.mthds/usage-stats/id`, with `$process_person_profile: false`, so PostHog builds no person profile from it. Nothing is sent for `--help`, `--version`, the banner, a command group run without its subcommand, an unknown command, or the `telemetry` group's own commands.

## Turning statistics off

Statistics are on unless any of these says off, and none of them can turn statistics back on over another:

| Switch | Effect |
| --- | --- |
| `DO_NOT_TRACK` set to anything but empty, `0` or `false` | Off for every tool |
| `PIPELEX_USAGE_STATS` set to `0`, `false`, `no` or `off` (any value it cannot read counts as off; empty, `1`, `true`, `yes` and `on` have no effect) | Off for every tool |
| `DISABLE_TELEMETRY` set to `1`, `true`, `yes` or `on` in the environment | Off for these CLIs |
| `mthds telemetry disable`, or another tool's disable command | Off on this machine, for every tool |
| `DISABLE_TELEMETRY=1` in `~/.mthds/config`, the opt-out of earlier versions | Off on this machine, carried into the shared state (see below) |
| `[usage_stats] enabled = false` in the project's `.pipelex/pipelex.toml` | Off for everyone working in the project; a file that cannot be read or holds the wrong types also turns them off |
| `PIPELEX_USAGE_STATS_ENDPOINT` set to anything but a loopback `http` origin | Off for the process |

The project is found the way pipelex finds it: walking up from the working directory to the first directory holding `.pipelex`, `.git`, `pyproject.toml`, `setup.py`, `setup.cfg`, `package.json` or `.hg`, never going past the home directory.

### The legacy opt-out

Earlier versions of these CLIs wrote `DISABLE_TELEMETRY=1` to `~/.mthds/config`. That choice still holds: the first command to see it creates the shared `disabled` file, deletes every queued event, and sets `~/.mthds/usage-stats/legacy-migrated` to the config file's modification time, so the migration runs once per change of the file. The CLIs never write `DISABLE_TELEMETRY` to the config file any more. Turning statistics back on (`mthds telemetry enable`, or `mthds config set telemetry true`) takes the key out of the file, so the old opt-out cannot return with a later write of the file; and when `mthds config set` writes another setting while the old opt-out is already carried over, or was turned back on by any tool, it dates the marker past that write, since a write for another setting is no new opt-out.

## Commands

The `mthds telemetry` group reads and writes the state every tool shares, so a choice made here holds for pipelex, plxt and the VS Code extension, and theirs holds here. `mthds-agent` has no group of its own.

| Command | What it does |
| --- | --- |
| `mthds telemetry status` | Says whether statistics are on and, when they are not, every switch keeping them off. Read-only: it creates nothing and migrates nothing. |
| `mthds telemetry status --format json` | Prints the contract's status object alone on stdout: `tool`, `enabled`, `off_by` (the switches' tokens, in the contract's order), `installation_id` (or `null`), `notice_version`, `internal`, `ci`, `container` and `state_dir`. |
| `mthds telemetry disable` | Creates the shared `disabled` file and deletes every tool's queued events. |
| `mthds telemetry enable` | Deletes the `disabled` file, takes a legacy `DISABLE_TELEMETRY` out of `~/.mthds/config` and settles the legacy opt-out; when a switch still keeps statistics off, it names it rather than claiming success. |
| `mthds telemetry reset-id` | Replaces the installation identifier, prints the new one, and deletes every tool's queued events, which were made under the old one. |

The `telemetry` configuration key reads and writes the same state. `mthds config set telemetry false` (or `0`, `no`, `off`) does what `disable` does, and `true` (or `1`, `yes`, `on`) what `enable` does. `mthds config get telemetry` answers in the `DISABLE_TELEMETRY` encoding, `1` meaning off: from `env` when a variable keeps statistics off, from `file` when the machine's choice or the legacy opt-out does.

## The shared state

Everything lives in `~/.mthds/usage-stats/`, created with mode `0700`:

| Path | Meaning |
| --- | --- |
| `id` | The installation identifier. Created once, by publishing a temporary file through a hard link, so first runs racing on a fresh machine agree on one. A malformed `id` is never rewritten: the process reports under an identifier of its own, kept nowhere. |
| `disabled` | Statistics are off on this machine, for every tool. |
| `notice-v1` | The notice was shown. |
| `legacy-migrated` | The legacy opt-out was carried over, as of this file's modification time. |
| `internal` | The machine is one of the team's; every event carries `internal: true`. |
| `spool/mthds/` | Events waiting to be sent. |

## Delivery

An exit handler cannot wait on the network, so a command writes its event to the spool as it exits and starts a detached sender (`dist/usage-stats/sender-main.js`), which posts the whole spool to `https://eu.i.posthog.com/batch/` within ten seconds while the command has already returned. A spool file holds at most the contract's number of files per tool, is claimed by renaming before it is posted so two senders never post one file, and is deleted once posted or refused; a file a sender could not post waits for the next one, and files older than the contract's age limit are deleted unsent.

In CI or a container, where a detached sender would be killed with the step, and whenever one cannot be started, the command posts its own event before exiting, through a sender it waits for at most one second. An event under a process-local identifier is posted the same way and never spooled. Statistics never change how a command ends: a failure to write, start or post is ignored.

## Debugging and testing

- `PIPELEX_USAGE_STATS_DEBUG=1` prints each event as one JSON line, `{"usage_stats_debug": {...}}`, on stderr instead of sending it. The switches still apply.
- `PIPELEX_USAGE_STATS_ENDPOINT=http://127.0.0.1:<port>` sends the events to a local server instead of PostHog. Only a loopback `http` origin is accepted; anything else turns statistics off for the process, so a mistyped value can never send events elsewhere.
- The test suite sets `DO_NOT_TRACK=1` for every test (`vitest.config.ts`), and CI sets it too. The tests of the statistics themselves build each CLI's environment from nothing, with a scratch home and a loopback capture server.

## Method events

`mthds install` and `mthds publish` (and their `mthds-agent` twins) also send a `method_install` or `method_publish` event for each method of a public GitHub repository, carrying the package's manifest fields one by one (address, name, version, description, display name, authors, licence, main pipe, MTHDS standard version and exports), never the manifest's raw text. They go to the project mthds.sh reads to rank methods, not the shared one, and follow only `DO_NOT_TRACK`, `DISABLE_TELEMETRY` in the environment, the shared `disabled` file and the legacy opt-out; `PIPELEX_USAGE_STATS`, the project setting and the endpoint override do not reach them. A `method_publish` event carries the address mthds.sh lists the method under. Publishing itself no longer depends on any of this: see [publishing.md](publishing.md).
