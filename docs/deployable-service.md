# Deployable Service

The first deployable target is a containerized Saga service process. It keeps the local CLI/control-plane workflow intact while defining a runtime shape that can move to hosted infrastructure later.

## Entrypoint

The service package owns its deployable entrypoint:

```sh
pnpm --filter @saga/service start
```

This runs `apps/service/src/main.ts`, loads typed runtime config, starts the HTTP service, and handles `SIGINT`/`SIGTERM` shutdown.

Startup validates database connectivity and migration compatibility before the health endpoint is exposed.

Apply migrations before starting or upgrading the service:

```sh
pnpm --filter @saga/service migrate
```

## Container

Build the service image:

```sh
docker compose -f docker-compose.service.yml build saga-service
```

Run the service with a colocated Postgres dependency:

```sh
docker compose -f docker-compose.service.yml up saga-service
```

The compose target includes a one-shot `migrate` service and requires it to complete before `saga-service` starts. Run it explicitly before upgrades so an already-created compose project does not reuse an older completed migration container:

```sh
docker compose -f docker-compose.service.yml run --rm migrate
```

The service container binds to `0.0.0.0:4766` and expects secrets/configuration through environment variables.

## Systemd

A starting systemd unit lives at `deploy/systemd/saga.service`. It assumes:

- the repo is installed at `/opt/saga`
- runtime config is injected through `/etc/saga/saga.env`
- a `saga` user/group owns the service process

Run migrations explicitly before first start and before each upgrade. The unit only starts the long-running service process; it does not mutate database schema during service startup.

Install shape:

```sh
sudo -u saga pnpm --dir /opt/saga --filter @saga/service migrate
sudo install -D -m 0644 deploy/systemd/saga.service /etc/systemd/system/saga.service
sudo systemctl daemon-reload
sudo systemctl enable --now saga.service
```

## Hosted Container

The hosted target is a provider-neutral container contract documented in `deploy/hosted/README.md`, with `deploy/hosted/service.env.example` showing the expected environment and managed secret file variables.

## Configuration

Required:

- `DATABASE_URL`

Common runtime settings:

- `SAGA_ENV=production`
- `SAGA_LOG_LEVEL=info`
- `SAGA_SERVICE_HOST=0.0.0.0`
- `SAGA_SERVICE_PORT=4766`

Secrets must be injected by the deployment environment. Do not bake real secrets into the image or compose files.

The service package declares `tsx` as a runtime dependency while this repo remains source-run/typecheck-only. If the build later emits JavaScript, switch the deploy entrypoint to the emitted artifact.

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
