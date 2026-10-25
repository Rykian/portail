FROM oven/bun:1.4.4 AS deps
WORKDIR /app
# The frozen-lockfile check needs every workspace manifest.
COPY package.json bun.lock bunfig.toml ./
COPY apps/portail/package.json apps/portail/
COPY apps/updater/package.json apps/updater/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --filter portail

FROM oven/bun:1.4.4 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app ./
COPY apps/portail apps/portail
COPY packages/shared packages/shared
WORKDIR /app/apps/portail
RUN bun run build

FROM oven/bun:1.4.4
WORKDIR /app/apps/portail
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=bun:bun /app/apps/portail/.next/standalone /app
COPY --from=build --chown=bun:bun /app/apps/portail/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/apps/portail/scripts/fetch-icons.mjs ./scripts/fetch-icons.mjs
USER bun
EXPOSE 3000
CMD ["bun", "server.js"]
