# mthds-js

TypeScript implementation of the mthds.ai open standard CLI.

## Build & Test

```bash
make install    # Install dependencies
make check      # Build + run tests (alias: make c)
make test       # Run test suite only (alias: make t)
make build      # TypeScript compilation only
make clean      # Remove dist/ and tsbuildinfo
```

Always run `make check` before committing. Always run the tests before committing.

## Architecture

```
src/
├── cli.ts                          # CLI entry point (Commander.js)
├── cli/commands/                   # Command handlers
│   ├── index.ts                    # Banner + logo
│   ├── run.ts                      # mthds run
│   ├── validate.ts                 # mthds validate
│   ├── build.ts                    # mthds build inputs
│   ├── config.ts                   # mthds config set|get|list
│   ├── setup.ts                    # mthds runner setup
│   ├── install.ts                  # mthds install (JS-only)
│   └── package/stubs.ts            # mthds package <cmd> (stubs)
├── protocol/                       # PURE MTHDS Protocol (interface + wire models) — see docs/architecture.md
│   ├── protocol.ts                 # MTHDSProtocol<PipeOutputT> (generic)
│   ├── models.ts                   # RunResultExecute<T>/RunResultStart, ModelDeck, VersionInfo, ValidationReport
│   ├── options.ts                  # Run/Start options + extension passthrough
│   ├── pipeline_inputs.ts          # StuffContentOrData, PipelineInputs
│   ├── pipe_output.ts              # VariableMultiplicity, PipeOutputAbstract
│   ├── concept.ts / stuff.ts / working_memory.ts  # abstract domain hierarchy (mirror mthds-python)
│   └── exceptions.ts               # PipelineRequestError (protocol base)
├── runners/                        # Runner implementations
│   ├── types.ts                    # Runner interface + request/response types
│   ├── registry.ts                 # createRunner() factory
│   ├── api/                        # MthdsApiClient (IS the api runner) + Dict models + errors
│   └── pipelex/runner.ts           # Pipelex CLI runner
├── config/
│   ├── config.ts                   # ~/.mthds/config handling
│   └── dotenv.ts                   # the config file's dotenv format
├── usage-stats/                    # Anonymous usage statistics (command_completed) — see docs/usage-statistics.md
│   ├── contract.ts                 # The shared contract's constants, checked against tests/fixtures/usage-statistics.json
│   ├── switches.ts / project.ts    # What turns statistics off
│   ├── state.ts / spool.ts         # ~/.mthds/usage-stats/: identifier, markers, queued events
│   ├── event.ts / outcome.ts       # Building the event
│   ├── session.ts                  # Commander hooks: notice, exit handler, delivery
│   └── sender.ts / sender-main.ts  # The sender process posting to PostHog
├── package/
│   ├── manifest/
│   │   ├── types.ts                # Manifest types
│   │   └── validate.ts             # METHODS.toml validation
│   └── exceptions.ts               # Package error types
└── installer/                      # JS-only: method installation
    ├── resolver/                   # GitHub/local method resolution
    ├── registry/                   # mthds.sh registry route client (publish) — see docs/publishing.md
    ├── telemetry/                  # method_install / method_publish events
    └── runtime/                    # Pipelex installer
```

## Testing

Tests use Vitest and are organized in tiers:

```
tests/
├── unit/                           # Fast, isolated tests
│   ├── config/config.test.ts
│   ├── runners/registry.test.ts
│   ├── package/manifest/validate.test.ts
│   └── installer/resolver/address.test.ts
├── integration/                    # Component interaction tests
└── e2e/                            # Full CLI invocation tests
```

The CLIs send usage statistics and method events, so tests never touch the real home or network: `vitest.config.ts` gives every test, and every CLI a test spawns, a scratch `HOME`, `DO_NOT_TRACK=1` and a loopback statistics endpoint, `tests/support/isolation-guard.ts` fails a test that connects to a non-loopback host, and the run fails if the real `~/.mthds/usage-stats/` changed. A test that builds a CLI's environment from scratch keeps a scratch `HOME` and a loopback `PIPELEX_USAGE_STATS_ENDPOINT` or `MTHDS_HUB_URL`. Run a built CLI by hand as `env HOME=$(mktemp -d) DO_NOT_TRACK=1 node dist/cli.js …` (a shell's unexported `DO_NOT_TRACK` does not reach it).

## Conventions

- Strict TypeScript with ESM modules (`.js` import extensions)
- Commander.js for CLI, `@clack/prompts` for interactive UI
- All runner operations go through the `Runner` interface
- Config stored in `~/.mthds/config` (dotenv format)
- Package management commands are stubs (use mthds-python)
