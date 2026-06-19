# @saga/db

Database schema, migrations, and Postgres-backed persistence services for Saga.

## Local Postgres

Start a local test database:

```sh
pnpm --filter @saga/db run db:test:up
```

Run the real Postgres integration test:

```sh
pnpm --filter @saga/db run test:postgres:local
```

Stop the database and remove its volume:

```sh
pnpm --filter @saga/db run db:test:down
```

The local test URL is:

```text
postgres://saga:saga@localhost:55432/saga_test
```

`test:postgres` still accepts `SAGA_TEST_DATABASE_URL` or `DATABASE_URL` for other Postgres providers.
