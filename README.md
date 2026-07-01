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
pnpm --filter @saga/cli saga init
pnpm --filter @saga/cli saga doctor
```

Search captured session memory and expand a segment hit:

```sh
pnpm --filter @saga/cli saga recall search "what changed in recall"
pnpm --filter @saga/cli saga recall show <segment-id> --window 2
```

`recall show` expands context by **Turn** window: `--window N` returns up to N normalized Turns
before and after the anchor within the same Session, Activity Interval, and Raw Session Record.
`--before`/`--after` override each side (`--window 5 --before 2` = 2 Turns before, 5 after).
Withheld or transformed content (skipped payloads, hard-redacted records) stays explicit and is
listed under a `Warnings` block rather than being replaced with indexed text.

Stop dependencies when finished:

```sh
pnpm deps:down
```

Build the deployable service container target:

```sh
docker compose -f docker-compose.service.yml build saga-service
```

## Notes

- [Database operations](docs/database-operations.md)
- [Deployable service](docs/deployable-service.md)
- [Harness targets](docs/harnesses.md)
