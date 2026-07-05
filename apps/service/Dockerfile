FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# bun is the package manager and task runner; the service itself still runs
# under Node (tsx). Pin the same version as .tool-versions.
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

# bun's frozen install requires every workspace member from bun.lock to be
# present, so copy all of apps/ (pnpm tolerated absent importers).
COPY package.json bun.lock bunfig.toml turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN bun install --frozen-lockfile

ENV SAGA_ENV=production
ENV SAGA_SERVICE_HOST=0.0.0.0
ENV SAGA_SERVICE_PORT=4766

EXPOSE 4766

CMD ["bun", "run", "--filter", "@saga/service", "start"]
