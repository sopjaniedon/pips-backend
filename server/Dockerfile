# API image (build context = repo root). Debian slim so sharp/argon2/prisma prebuilt binaries work.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json server/
COPY migration/package.json migration/
COPY e2e/package.json e2e/
RUN pnpm install --filter @pips/server... --frozen-lockfile
COPY server server
RUN pnpm --filter @pips/server exec prisma generate && pnpm --filter @pips/server build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/server
USER node
EXPOSE 8080
CMD ["sh", "-c", "node ./node_modules/prisma/build/index.js migrate deploy && node dist/index.js"]
