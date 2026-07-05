FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# bun is the package manager and task runner; the service itself still runs
# under Node (tsx). Pin the same version as .tool-versions.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

# Manifests first so the install layer only invalidates when dependencies
# change. bun's frozen install requires every workspace member from bun.lock
# to be present, so every member's package.json is copied.
COPY package.json bun.lock bunfig.toml turbo.json tsconfig.json ./
COPY apps/cli/package.json ./apps/cli/
COPY apps/control-plane/package.json ./apps/control-plane/
COPY apps/service/package.json ./apps/service/
COPY packages/active-context/package.json ./packages/active-context/
COPY packages/claims/package.json ./packages/claims/
COPY packages/collectors/package.json ./packages/collectors/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/runtime/package.json ./packages/runtime/

RUN bun install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

ENV SAGA_ENV=production
ENV SAGA_SERVICE_HOST=0.0.0.0
ENV SAGA_SERVICE_PORT=4766

EXPOSE 4766

# Exec-form direct invocation: the service process is PID 1 and receives
# SIGTERM itself. `bun run --filter` supervision does not forward SIGTERM to
# the script child (verified against bun 1.3.14), which broke graceful
# shutdown under `docker stop`. Same cwd bun run used for the package script.
WORKDIR /app/apps/service

CMD ["node", "--import", "tsx", "src/main.ts"]
