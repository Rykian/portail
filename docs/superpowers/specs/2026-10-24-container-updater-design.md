# Container updater — design

Date: 2026-10-24

## Why

Today every update means SSH into CT 100, `cd /root/<stack>` and `docker compose pull && docker compose up -d`, stack by stack, without knowing what changed. Some stacks need more than that (a version variable for Mealie, a per-minor procedure for Authentik, a backup before Sure or Seerr), and those steps are easy to get wrong: before this design, a plain `up -d` would have downgraded Authentik from 2026.8.3 to 2026.8.1.

Goal: from the portal, an admin sees which stacks have an update, which version they would move to, and applies them with one click, watching the log live. No SSH for routine updates.

## Goals

- Admin-only page in the portal listing every stack with its update status, current → available version when known.
- Badge on the avatar and a « Mises à jour (N) » entry in the user menu when updates are available.
- Update one stack, or « Tout mettre à jour » in sequence; live log; stop at the first failure.
- Manual rollback to the previous version.
- History of past updates (who, when, stack, from → to, result, log).
- Stacks discovered automatically; config only holds exclusions and per-stack overrides.
- Replaces WUD (to be removed from CT 100 once this works).

## Non-goals

- Automatic (unattended) updates.
- Notifications other than the badge (no mail, no push).
- Updating individual services inside a stack: the unit is always the whole compose project.
- Containers not managed by compose (Portainer, started with `docker run`).
- The updater updating itself.
- Multiple Docker hosts.
- Editing secrets or arbitrary compose content from the UI.

## Context (CT 100 inventory, 2026-10-24)

- Debian 13, Docker 29, `docker compose` plugin v5. Everything runs as root.
- Stacks are directories `/root/<stack>/` with `compose.yml` or `docker-compose.yml`; project name = directory name. Current stacks: authentik, cloudflared, downloads (15 containers, several sharing gluetun's network), frigate, group-gate, ledfx, mealie, portal, sentinel-yt, stirling, sure, traefik, wud. `/root/authelia` is abandoned; `*.back` / `*.bak-*` are backups.
- Most images use floating tags (`latest`, `stable`, `:2`, `v3.7`). Mealie uses `${VERSION}`, Authentik `${AUTHENTIK_TAG}`, both now pinned in their `.env` (done by hand before this work). group-gate pins `nginx:1.31.6-alpine` literally in its compose file.
- The portal is exposed to the internet through Cloudflare Tunnel, behind Traefik, on the external `proxy` network. It must not get `docker.sock`.
- Cron runs `docker system prune -f --volumes` daily at 04:30: dangling images disappear overnight.
- Backups: vzdump of CT 100, keep-last=1.

## Decisions

| Topic | Decision |
|---|---|
| Architecture | Separate service, the **updater**, owns all Docker access. The portal is the only UI and talks to it server-side. |
| Updater stack | NestJS (TypeScript) on the Bun runtime, Bun as package manager, same repository as the portal. The portal stays on Node 24 + npm. |
| Updater libraries | zod (shared schemas), ts-pattern for exhaustive matching on discriminated unions (update mode, job status, container health), remeda for data transforms (sorting, grouping, filtering stacks and tags) |
| API style | REST + Server-Sent Events for live logs |
| Detection | Built into the updater (no WUD) |
| List view | Table by default, toggle to cards; choice remembered in `localStorage` |
| Failure | Sequence stops at the first failure; no automatic rollback |
| Rollback | Manual button |
| History | Kept in the updater |

## Architecture

```
browser ──HTTPS──▶ portal (Next.js, networks: proxy + updater)
                     │  admin check, then relays to the updater
                     ▼  Bearer token, HTTP on the `updater` network
                   updater (NestJS, network: updater only)
                     ├─ /var/run/docker.sock
                     ├─ /root  (bind-mounted at the same path)
                     └─ /data  (SQLite history, rollback state)
```

- The updater is **not** on the `proxy` network and has no Traefik route or tunnel hostname. Only the portal can reach it. The `updater` network must allow outbound internet (registries), so it is a normal bridge network, not `internal: true`.
- Every request carries `Authorization: Bearer <UPDATER_TOKEN>` (shared secret in both `.env` files). Requests that start an action also carry the acting user (`X-Updater-User: <email>`), trusted because of the token, and stored in history.
- The browser never talks to the updater. Portal route handlers under `/api/updates/...` check `isAdmin(user.groups)` and forward, including the SSE stream.
- `/root` is mounted at `/root` because compose resolves relative bind mounts on the client side: the paths the updater sees must be the host paths. This gives the updater root-equivalent access to the host, which is accepted: that is why it is isolated from the internet-facing portal.
- The updater image (based on `oven/bun`) contains the Docker CLI and the compose plugin and shells out to `docker compose` with `Bun.spawn`. It does not reimplement compose.

## Stack discovery and configuration

On every check, the updater lists `/root/*` directories that contain `compose.yml`, `compose.yaml`, `docker-compose.yml` or `docker-compose.yaml`. Project name = directory name. A new stack appears with no configuration, in the default mode.

Config file `/root/updater/config.yml` (re-read on every check, validated with zod; an invalid file is reported in the UI and the previous valid config is kept):

```yaml
exclude: [authelia, updater, wud, "*.back", "*.bak-*"]

stacks:
  mealie:
    version: { file: .env, variable: VERSION }
  authentik:
    recipe: authentik
    version: { file: .env, variable: AUTHENTIK_TAG }
  sure:
    confirm: true
    before:
      - docker compose exec -T db pg_dump -U sure sure > backups/sure-$(date +%F).sql
  downloads:
    before:
      - tar czf backups/seer-$(date +%F).tgz seer
    beforeOnlyOnMajor: true
  frigate: { confirm: true }
  traefik: { last: true }
  cloudflared: { last: true }
  portal: { last: true }
```

(Values above are illustrative; the exact commands are set on CT 100.)

Per-stack keys:

| Key | Meaning |
|---|---|
| `version` | The stack's version lives in a variable: `file` (relative to the stack dir) and `variable` name. Updating rewrites that one line. |
| `recipe` | Named built-in procedure (only `authentik` in v1). |
| `confirm` | Needs an explicit confirmation and is left out of « Tout mettre à jour ». |
| `last` | Runs at the end of « Tout mettre à jour » (stacks that cut access to the portal). |
| `before` | Shell commands run in the stack directory before the update; a non-zero exit fails the update. |
| `beforeOnlyOnMajor` | Run `before` only when the update is a major version bump (or unknown version for floating tags: then always run). |

## Update modes

1. **Pull (default).** `docker compose pull` then `docker compose up -d` for the whole project. Covers floating tags, and makes downloads (gluetun + dependants) update as a block for free.
2. **Version variable** (`version` set). Rewrite `VARIABLE=<new tag>` in the file, then pull + up. Keep the rest of the file byte-for-byte.
3. **Recipe `authentik`.** A new patch within the current minor (2026.8.3 → 2026.8.4) is a plain version-variable update: no confirmation, included in « Tout mettre à jour » (Authentik is then run with the `last` stacks). *(Designer's call.)* Only a minor change goes through the recipe, one minor at a time: the target is the latest patch of the *next* published minor (2026.8.x → 2026.10.y if 2026.9 does not exist).

   The recipe relies on compose's automatic override file: `/root/authentik/compose.yml` is **upstream's file, unmodified**, and every local addition (Traefik labels, `proxy` network, extra volumes…) lives in `compose.override.yml`, using `!reset` / `!override` where upstream values must be removed or replaced. Steps:
   1. Fetch upstream `https://goauthentik.io/version/<YYYY.M>/lifecycle/container/compose.yml` for the **current** minor and compare it with the local `compose.yml`, ignoring line-ending differences and the default value in `${AUTHENTIK_TAG:-…}` (upstream bumps that default on every patch release of the same minor, so a stack updated by patch would otherwise always differ). If they differ, refuse with « Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml ». Nothing is changed.
   2. Fetch upstream for the **target** minor and show the diff current upstream → target upstream, plus the target version. Wait for the admin's confirmation.
   3. Save the current `compose.yml` and `AUTHENTIK_TAG` (rollback), write the target upstream file as `compose.yml`, set `AUTHENTIK_TAG`, pull, up.

A stack whose image tag is a full version written literally in the compose file (group-gate) shows « nouvelle version disponible : 1.31.6 → 1.31.7 » but no update button, with the hint « Passer la version dans une variable pour l'activer ». Floating tags such as `v3.7` or `:2` are pull mode.

## Detection

Scheduled every 6 hours and on demand (« Vérifier maintenant »). For each service of each stack:

- **Floating tag:** compare the registry manifest digest for the tag with the local image's `RepoDigests`. Different = update available. If the remote image config has `org.opencontainers.image.version` and so does the local one, display `local → remote`; otherwise display « nouvelle image du <date> » from the remote image's created date.
- **Version variable / literal version:** list the registry's tags, keep those with the same shape as the current one (same prefix such as `v`, same number of numeric segments, same suffix such as `-alpine`), compare numerically, take the highest above the current one.
- A stack has an update if any of its services has one. The stack row lists the services concerned.
- **Major bump:** first numeric segment increases (for date-style versions like Authentik's `2026.8`, a year change is not treated as major; the recipe covers Authentik). Major bumps get `confirm` behaviour automatically.

Registries in use: Docker Hub, GHCR, lscr.io, and possibly quay.io; all anonymous, public images. Use HEAD requests for manifests where possible (they do not count against Docker Hub's pull limit). Whether to call the registry HTTP API directly or ship a tool like `regctl` / `skopeo` in the image is left to the builder.

Last check time and per-stack results are stored, so the portal can show « Vérifié il y a 2 h » and the badge without triggering a check.

## Running updates

- **One job at a time**, globally. Starting a job while one runs returns `409`.
- A job runs in the updater regardless of the client: closing the tab or losing the connection (expected when traefik, cloudflared, authentik or the portal restart) does not stop it. The SSE stream replays the job's log from the start, then follows it; the page reconnects automatically.
- **Success check:** the compose commands exit 0, then within 60 s every container of the project that was running before the update is `running` again and, if it has a healthcheck, `healthy`. A container that is `restarting`, `exited` with a non-zero code, or `unhealthy` at 60 s fails the update. Containers stopped before the update, services outside the active profiles, and one-shot containers that exit with code 0 are ignored. *(Designer's call.)*
- **`before` commands** run inside the updater container (cwd = stack directory, `sh -c`), not on the host. The image ships `sh`, `tar`, `gzip` and the Docker CLI + compose plugin; anything else must be added to the image explicitly. Commands needing host-only things (systemd, host binaries, paths outside `/root`) are not supported; `docker compose exec` into the stack's own containers is the way to run tools they contain (e.g. `pg_dump`). *(Designer's call.)*
- **« Tout mettre à jour »:** all stacks with an update, excluding those with `confirm`, a `recipe`, a major bump, or no button (literal versions). Stacks with `last` go at the end. The sequence stops at the first failure; the remaining stacks are untouched and listed as « non lancées ».
- If the updater restarts mid-job, the job is marked « interrompue » at startup.

## Rollback

Before changing anything, the updater records what is needed to go back:

- **Pull mode:** for every service, tag the image currently used by the container as `updater-rollback/<project>-<service>:latest` (this also protects it from the 04:30 prune). Rollback re-tags each saved image to the reference the compose file uses, then `docker compose up -d`. Only the last state per stack is kept; older rollback tags are removed.
- **Version variable:** the previous value. Rollback writes it back, then `up -d` (the old image is still tagged locally by its version, so no pull needed; pull if absent).
- **Recipe:** previous `compose.yml` and variable value.

The button « Revenir à <version> » appears on the failed job and on the stack row until the next update of that stack. For stacks that migrate their database on start (Authentik, Sure, Frigate on a major), the confirmation says rollback may not work and the real safety net is the vzdump backup. Rollbacks are jobs too and go into history.

## API (updater)

All JSON unless stated. Schemas defined once with zod and imported by both apps.

```
GET  /stacks                  list: name, mode, flags, services, current/available versions, update?, rollback?, lastCheck
POST /checks                  run a check now (job)
POST /stacks/:name/update     start an update, body { confirm?: true } → { jobId }
POST /stacks/:name/rollback   start a rollback → { jobId }
POST /updates                 « Tout mettre à jour » → { jobId }
GET  /jobs/:id                job status and result
GET  /jobs/:id/events         SSE: log lines, step changes, final status (replays from start)
GET  /history?cursor=         paginated past jobs
GET  /health                  liveness, no token needed
```

For the Authentik recipe on a minor change, `POST /stacks/authentik/update` without `confirm` returns the target version and the upstream-to-upstream compose diff (or the « modifications locales » refusal) instead of starting.

## Portal side

- Home page, admins only: fetch the update count from the updater with a short timeout (~1 s). On error or timeout, no badge; the page must never fail because the updater is down.
- Avatar: red pill with the count. User menu: « Mises à jour » entry (with count) between « Administration » and « Se déconnecter ».
- Page `/admin/updates` (non-admins: 404). Two tabs: « Mises à jour » and « Historique ».
  - Header: « Vérifié il y a … », « Vérifier maintenant », « Tout mettre à jour », view toggle tableau / cartes.
  - Table: stack, version change (or « nouvelles images » + services), mode, button. Up-to-date stacks are collapsed into one line.
  - Cards: same information as a grid, matching the home page look.
  - Running job: panel with the live log, step status, and the rollback button on failure.
  - Historique: date, user, stack, from → to, result; click to open the stored log.
- If the updater is unreachable, the page says so instead of crashing.

Mockups from the brainstorm: `.superpowers/brainstorm/` (not committed).

## Persistence

SQLite in `/data` with Bun's built-in `bun:sqlite`: config errors, check results, jobs with their logs, rollback state. Job metadata kept forever; logs deleted after 90 days.

## Delivery

- Code under `updater/` in this repository, own `package.json` and `bun.lock` (the portal keeps `package-lock.json`); NestJS needs `experimentalDecorators` and `emitDecoratorMetadata` in the updater's `tsconfig.json`, which Bun honours. Shared zod schemas imported by the portal through a path alias. Exact layout left to the builder, provided the schemas have a single source. Because the portal runs on Node and the updater on Bun, the shared schemas must not import any Bun API, and `zod` must resolve to a single version for both apps (shared folder outside `updater/`, or the same pinned `zod` version in both `package.json` files).
- CI: the existing lint / format / typecheck / test steps also run for the updater, using `oven-sh/setup-bun` and `bun ci`; a second image job publishes `ghcr.io/rykian/portail-updater` (`latest` + `sha-` tags) on main.
- `deploy/updater-compose.yml` → `/root/updater/compose.yml` on CT 100, with `.env` (`UPDATER_TOKEN`), `config.yml`, `data/`. `deploy/compose.yml` (portal) gains the `updater` network and `UPDATER_URL` / `UPDATER_TOKEN`.
- README: deployment steps and config reference.

## Testing

- Unit (Vitest, run with `bun --bun vitest` so Bun APIs such as `bun:sqlite` are available): discovery and exclusions, config validation and merge, tag shape matching and version comparison, major detection, `.env` rewriting, sequence ordering and stop-on-failure, health evaluation.
- Updater integration: Docker and registry access behind interfaces, faked in tests.
- Portal e2e (Playwright): admin sees badge, page, both views, history; non-admin gets no badge and 404; updater down does not break the home page. Updater faked.
- Manual acceptance on CT 100: update a harmless stack (stirling), roll it back, update Mealie via its variable.

## Left to the builder

Registry client approach, internal module layout, polling vs. in-memory scheduling details, exact UI components (shadcn/Base UI, as in the portal), wording of secondary UI strings (French).

## Prerequisites on CT 100 (manual, before going live)

- Done: `AUTHENTIK_TAG` and `VERSION` pinned in the Authentik and Mealie `.env` files; Mealie secrets moved to `.env`.
- Done (2026-10-24): `/root/authentik/compose.yml` is upstream's 2026.8 file, unmodified. There were no local additions, so no `compose.override.yml` exists; the recipe must work with or without it (compose rejects an empty file, so never create one). Traefik reaches Authentik through its file provider, not labels.

Observed on the Authentik stack, to handle correctly:
- Every compose command prints a warning that volume `authentik_database` was not created by Compose. It is harmless: warnings on stderr are not failures; only exit codes and the health check count.
- Upstream uses `env_file: .env` on every service, so changing `AUTHENTIK_TAG` also recreates `postgresql`. Expected.
- After acceptance: remove WUD.
