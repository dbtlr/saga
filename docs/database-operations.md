# Database Operations

Saga is local-first for the current unstable phase, but database operations should still avoid silent data loss.

## Local Postgres

Start the local development database:

```sh
bun run deps:up
cp .env.example .env.local
bun run --filter '@saga/cli' saga init
```

The local development database listens on `localhost:55433` and stores data in the Docker volume `saga_saga-db-local-data`.

## Migration Safety

`saga init` runs migrations through the guarded migration flow:

- Missing Drizzle migration table is treated as `0` applied migrations.
- Already-current databases skip migration execution.
- Databases with more applied migrations than this Saga build expects fail fast. Upgrade Saga or restore a compatible backup before continuing.

`saga doctor` reports Postgres connectivity and migration status separately.

## Backups

Create a local backup before risky migration or recovery work:

```sh
mkdir -p backups
pg_dump "$SAGA_DATABASE_URL" --format=custom --file "backups/saga-$(date +%Y%m%d-%H%M%S).dump"
```

Restore into a fresh local database:

```sh
createdb saga_restore
pg_restore --dbname saga_restore --clean --if-exists backups/<backup-file>.dump
```

Do not commit backup files. They may contain workspace activity, source metadata, and secrets captured in raw event payloads.
