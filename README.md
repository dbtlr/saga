# Saga

> Looking for the legacy Saga skills/plugin implementation? It now lives in
> [`saga-plugin`](https://github.com/dbtlr/saga-plugin).

Saga is intended to be a workspace memory system for agentic work. It ingests raw
activity and source state, derives scoped claims with provenance, compiles active
context, and exposes memory through MCP, CLI, hooks, and a web UI.

## Local Development

Start the local Postgres dependency:

```sh
pnpm deps:up
```

Create a local environment file from the example:

```sh
cp .env.example .env.local
```

Then initialize or inspect the workspace:

```sh
pnpm --filter @saga/cli exec saga init
pnpm --filter @saga/cli exec saga doctor
```

Stop dependencies when finished:

```sh
pnpm deps:down
```

## Notes

- [Database operations](docs/database-operations.md)
- [Harness targets](docs/harnesses.md)
