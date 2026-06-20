# Deployable Service

The first deployable target is a containerized Saga service process. It keeps the local CLI/control-plane workflow intact while defining a runtime shape that can move to hosted infrastructure later.

## Entrypoint

The service package owns its deployable entrypoint:

```sh
pnpm --filter @saga/service start
```

This runs `apps/service/src/main.ts`, loads typed runtime config, starts the HTTP service, and handles `SIGINT`/`SIGTERM` shutdown.

## Container

Build the service image:

```sh
docker compose -f docker-compose.service.yml build saga-service
```

Run the service with a colocated Postgres dependency:

```sh
docker compose -f docker-compose.service.yml up saga-service
```

The container binds the service to `0.0.0.0:4766` and expects secrets/configuration through environment variables.

## Configuration

Required:

- `DATABASE_URL`

Common runtime settings:

- `SAGA_ENV=production`
- `SAGA_LOG_LEVEL=info`
- `SAGA_SERVICE_HOST=0.0.0.0`
- `SAGA_SERVICE_PORT=4766`

Secrets must be injected by the deployment environment. Do not bake real secrets into the image or compose files.

## Managed Secrets

Secret-bearing config supports standard file indirection:

- `DATABASE_URL_FILE`
- `OPENAI_API_KEY_FILE`

When both direct and file-backed values are set, the direct environment variable wins. This keeps local `.env.local` usage simple while allowing container platforms, Docker/Kubernetes secrets, and hosted secret managers to inject file-backed values.

Example:

```sh
DATABASE_URL_FILE=/run/secrets/saga_database_url
OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
```
