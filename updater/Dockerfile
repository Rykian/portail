FROM oven/bun:1.4.4 AS deps
WORKDIR /app/updater
COPY updater/package.json updater/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.4
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app/updater
COPY --from=deps /app/updater/node_modules ./node_modules
COPY updater/package.json updater/tsconfig.json ./
COPY updater/src ./src
COPY shared /app/shared
# shared/ resolves zod by walking up from /app/shared.
RUN ln -s /app/updater/node_modules /app/node_modules
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["bun", "src/main.ts"]
