FROM oven/bun:1.4.4 AS deps
WORKDIR /app
# The frozen-lockfile check needs every workspace manifest.
COPY package.json bun.lock bunfig.toml ./
COPY apps/portail/package.json apps/portail/
COPY apps/updater/package.json apps/updater/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production --filter updater

FROM oven/bun:1.4.4
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=deps /app /app
WORKDIR /app/apps/updater
COPY apps/updater/package.json apps/updater/tsconfig.json ./
COPY apps/updater/src ./src
COPY packages/shared /app/packages/shared
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["bun", "src/main.ts"]
