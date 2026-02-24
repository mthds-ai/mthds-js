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
│   ├── build.ts                    # mthds build pipe|runner|inputs|output
│   ├── config.ts                   # mthds config set|get|list
│   ├── setup.ts                    # mthds setup runner
│   ├── install.ts                  # mthds install (JS-only)
│   └── package/stubs.ts            # mthds package <cmd> (stubs)
├── client/                         # API client
│   ├── client.ts
│   ├── protocol.ts
│   ├── pipeline.ts
│   ├── exceptions.ts
│   └── models/                     # Pydantic-equivalent models
├── runners/                        # Runner implementations
│   ├── types.ts                    # Runner interface + request/response types
│   ├── registry.ts                 # createRunner() factory
│   ├── api-runner.ts               # API runner
│   └── pipelex-runner.ts           # Pipelex CLI runner
├── config/
│   ├── credentials.ts              # ~/.mthds/credentials handling
│   └── config.ts                   # Re-export wrapper
├── package/
│   ├── manifest/
│   │   ├── types.ts                # Manifest types
│   │   └── validate.ts             # METHODS.toml validation
│   └── exceptions.ts               # Package error types
└── installer/                      # JS-only: method installation
    ├── resolver/                   # GitHub/local method resolution
    ├── agents/                     # AI agent handlers
    ├── telemetry/                  # PostHog tracking
    └── runtime/                    # Pipelex installer
```

## Testing

Tests use Vitest and are organized in tiers:

```
tests/
├── unit/                           # Fast, isolated tests
│   ├── config/credentials.test.ts
│   ├── runners/registry.test.ts
│   ├── package/manifest/validate.test.ts
│   └── installer/resolver/address.test.ts
├── integration/                    # Component interaction tests
└── e2e/                            # Full CLI invocation tests
```

## Conventions

- Strict TypeScript with ESM modules (`.js` import extensions)
- Commander.js for CLI, `@clack/prompts` for interactive UI
- All runner operations go through the `Runner` interface
- Config stored in `~/.mthds/credentials` (dotenv format)
- Package management commands are stubs (use mthds-python)
