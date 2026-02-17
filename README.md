# mthds

CLI for installing and managing **methods** — reusable workflows for AI coding agents.

## What is a method?

A method is a packaged workflow that an AI agent (like Claude Code) can use. Methods are stored in a registry and installed locally via their unique slug.

## Install a method

```bash
npx mthds install <slug>
```

The CLI will:

1. Look up the method in the registry
2. Ask which AI agent to install it for (Claude Code, with more coming soon)
3. Ask where to install — **local** (current project) or **global** (your machine)
4. Optionally install the pipelex software runtime
5. Write the method to `.claude/methods/<slug>/METHOD.mthds`

### Install locations

| Location | Path |
|----------|------|
| Local | `<cwd>/.claude/methods/<slug>/` |
| Global | `~/.claude/methods/<slug>/` |

## Install software runtime

```bash
npx mthds setup software pipelex
```

Installs [uv](https://docs.astral.sh/uv/) and [pipelex](https://pipelex.dev) so methods that depend on them can run.

## Telemetry

Anonymous usage data (method slug + timestamp) is collected to help rank methods on the leaderboard. No personal or device information is collected.

To opt out:

```bash
DISABLE_TELEMETRY=1 npx mthds install <slug>
```

## Development

```bash
make install    # install dependencies
make check      # typecheck + build
make dev        # watch mode
make run        # build and run the CLI
make pack       # create tarball for local npx testing
```

## License

MIT
