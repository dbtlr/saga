FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.json ./
COPY apps/service ./apps/service
COPY packages ./packages

RUN corepack enable pnpm && pnpm install --frozen-lockfile

ENV SAGA_ENV=production
ENV SAGA_SERVICE_HOST=0.0.0.0
ENV SAGA_SERVICE_PORT=4766

EXPOSE 4766

CMD ["pnpm", "--filter", "@saga/service", "start"]
