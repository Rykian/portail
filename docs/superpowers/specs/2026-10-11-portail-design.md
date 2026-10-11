# Portail payoux.net — design

Date: 2026-10-11
Source brief: Claude Doc « Portail payoux.net — handoff » (https://claude.ai/artifact/PXBmgTyKhQ5qnendDxGb8b)

## Goal

A single page at `https://payoux.net`, behind Authentik, listing the household's services. Each user sees only the services of their Authentik groups. Services not reachable from the visitor's current origin (LAN or internet) stay listed but dimmed. UI and descriptions are in French, for non-technical family members.

### Requirements (from the brief)

| # | Requirement |
|---|---|
| R1 | Served on `https://payoux.net`, behind Authentik, on the LAN and through the Cloudflare Tunnel |
| R2 | Service list maintained by hand in one YAML file; changes picked up without rebuild or restart |
| R3 | Filtered by Authentik group, server-side: a user never receives entries for groups they are not in |
| R4 | Origin changes opacity only: LAN-only services seen from the internet are dimmed with « À la maison uniquement » |
| R5 | User menu: name, avatar or initials, « Mon compte », « Se déconnecter » (+ « Administration » for admins) |
| R6 | Search field: name, description, section, accent-insensitive, shortcut `/` |
| R7 | One icon per service, downloaded once and served locally |
| R8 | One short French description per service, no jargon |

Out of scope: health checks, widgets, editing the list from the UI, and the infrastructure steps of the brief (Authentik provider/application, Traefik `conf.d/portal.yml`, Cloudflare public hostname, restricting the forward-auth provider). Those are a dependency for production, done separately on CT 100.

## Decisions

| Topic | Decision |
|---|---|
| Framework | Next.js 16, App Router, TypeScript, `output: 'standalone'` |
| Auth | Auth.js v5 (`next-auth`) with the Authentik OIDC provider, JWT session cookie, no database |
| UI | Tailwind v4 + shadcn/ui on Base UI primitives (`@base-ui/react`) |
| Data | `yaml` to parse, `zod` to validate |
| Package manager | npm |
| Tests | Vitest (pure logic) + Playwright (page, with the dev fake user) |
| Delivery | GitHub Actions builds the image and pushes to GHCR; CT 100 pulls it |
| Repository | Public, `github.com/Rykian/portail`; image `ghcr.io/rykian/portail` |
| Local dev auth | Fake user in development only, no Authentik needed |

## Structure

```
app/
  layout.tsx                  lang="fr", <title>Portail</title>, system theme
  page.tsx                    server component: user + origin + services → <Portal>
  api/auth/[...nextauth]/route.ts
  icons/[name]/route.ts       serves ICONS_DIR/<name>.png
auth.ts                       Auth.js config, getUser() (incl. dev fake user)
proxy.ts                      no session → sign in (Next 16 name for middleware)
lib/
  services.ts                 load + validate + cache services.yml
  visibility.ts               pure: (config, groups, origin) → visible sections
  origin.ts                   pure: header value → 'lan' | 'internet'
  search.ts                   pure: normalise + match
components/
  portal.tsx                  client: search state, keyboard shortcuts, grid
  service-card.tsx            icon, name, description, dimmed state
  user-menu.tsx               shadcn Avatar + Menu (Base UI)
  ui/                         shadcn-generated components
scripts/fetch-icons.mjs       downloads icons into ICONS_DIR
services.example.yml          two example entries
deploy/compose.yml            template for /root/portal on CT 100
Dockerfile
.github/workflows/build.yml
```

Boundaries:

- `visibility`, `origin` and `search` import nothing from Next.js and are tested directly.
- `services.ts` is the only code that reads the service list from disk.
- The browser receives only the output of `visibility()`; hidden entries never leave the server.
- `getUser()` in `auth.ts` is the only way pages and the proxy obtain the current user.

## services.yml

Format as in the brief, with `icon` being a slug rather than a file name:

```yaml
sections:            # display order
  - Maison
  - Médias
  - Outils
  - Téléchargements
  - Infrastructure

services:
  - name: Home Assistant
    url: https://ha.payoux.net
    icon: home-assistant             # ICONS_DIR/home-assistant.png
    section: Maison
    description: La maison connectée : lumières, chauffage, alarmes et scénarios.
    groups: [family]                 # who sees it
    reach: everywhere                # everywhere | lan
```

Zod schema:

- `sections`: non-empty array of non-empty strings, unique.
- `services[]`: `name` (non-empty), `url` (valid URL), `icon` (matches `^[a-z0-9-]+$`), `section` (must be one of `sections`), `description` (non-empty), `groups` (non-empty array of strings), `reach` (`everywhere` | `lan`).

Loading (`loadServices()`):

- Path from `SERVICES_FILE` (default `/data/services.yml`).
- On each call, `stat` the file; re-read and re-validate only when `mtimeMs` changed.
- Invalid file with a previous good version cached: keep serving the good version, log the zod error (path + message) with `console.error`.
- Invalid or missing file with no good version: throw; the page shows the unavailable message (see Errors).

The real 27-entry list from the brief lives only on CT 100. It is written as a separate file for the user to copy there, not committed.

## Visibility

`visibleSections(config, userGroups, origin)` returns `{ name, services: { name, url, icon, description, section, dimmed }[] }[]`:

- A service is included when `service.groups ∩ userGroups` is non-empty.
- `dimmed = service.reach === 'lan' && origin === 'internet'`.
- Sections follow the order of `config.sections`; sections with no included service are dropped.
- `isAdmin(groups)` is true when `groups` includes the constant `ADMIN_GROUP = 'authentik Admins'`.

## Origin

`parseOrigin(value: string | null)`: `'internet'` when the value is exactly `internet`, otherwise `'lan'` (missing header in local dev or direct port access, or junk). Read from `headers().get('x-portal-origin')`. `X-Forwarded-For` is never used.

In development only, when the header is missing, `DEV_ORIGIN` (`lan` | `internet`) is used instead.

## Authentication

Auth.js v5 with the built-in Authentik provider:

- Env: `AUTH_SECRET`, `AUTH_AUTHENTIK_ID`, `AUTH_AUTHENTIK_SECRET`, `AUTH_AUTHENTIK_ISSUER=https://auth.payoux.net/application/o/portail/`, `AUTH_URL=https://payoux.net`, `AUTH_TRUST_HOST=true`.
- Scopes: `openid email profile avatar` (`avatar` is the custom Authentik scope mapping returning `{"picture": request.user.avatar}`).
- `jwt` callback, on sign-in only: store `groups` (from the `groups` claim, default `[]`) and `picture` in the token.
- `session` callback: expose `user.name`, `user.email`, `user.image`, `user.groups`.
- Group changes take effect at the next sign-in.

`proxy.ts`: every route except `/api/auth/*` and Next.js static assets requires a user from `getUser()`; otherwise redirect to `/api/auth/signin/authentik` (straight to Authentik, no Auth.js sign-in page). `/icons/*` is protected like the page.

Sign-out: a server action calls `signOut({ redirect: false })`, then redirects to `https://auth.payoux.net/application/o/portail/end-session/` so the Authentik session ends too.

### Dev fake user

`getUser()` returns `{ name: 'Dev', email: 'dev@localhost', image: null, groups: DEV_USER_GROUPS.split(',') }` when `process.env.NODE_ENV === 'development'` and `DEV_USER_GROUPS` is set; `proxy.ts` then lets requests through without a session. `next build` / `next start` always run with `NODE_ENV=production`, so the production image cannot enable it.

## Icons

Route `app/icons/[name]/route.ts`:

- `name` must match `^[a-z0-9-]+$`, else 400.
- Reads `ICONS_DIR/<name>.png` (default `/data/icons`); missing → 404.
- Responds `Content-Type: image/png`, `Cache-Control: private, max-age=86400`.

Card: `<img src="/icons/<slug>">`; on `onError`, replaced by a tile with the service's first letter on a background colour derived from a hash of the name.

`scripts/fetch-icons.mjs` (plain ESM, no build step, shipped in the image):

- Reads `SERVICES_FILE`, collects icon slugs, skips those already in `ICONS_DIR`.
- Downloads `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/<slug>.png`.
- Keeps the file only if it starts with the PNG signature `89 50 4E 47 0D 0A 1A 0A`.
- Prints downloaded, skipped and failed slugs; exits 0.
- Run on CT 100: `docker compose run --rm -v ./data/icons:/data/icons portal node scripts/fetch-icons.mjs` (re-mounts `icons/` read-write for that run).

HyperHDR, LedFx and Shelfarr are not in dashboard-icons: their PNGs are dropped into `data/icons/` by hand, or they get the initial tile.

## Page

- Header: « Portail », search input (placeholder « Rechercher… (/) »), user menu on the right.
- One block per section, in `sections` order: heading + grid of cards (1 column on mobile, up to 4 on wide screens).
- Card: whole card is a link (same tab) with icon, name, one-line description. Dimmed cards: `opacity-40` and the hint « À la maison uniquement »; the link stays active.
- Light and dark themes follow the system (`prefers-color-scheme`), no toggle.

User menu (shadcn Avatar + Menu on Base UI):

- Trigger: avatar image, or initials from the name when absent.
- Header: name and e-mail.
- « Mon compte » → `https://auth.payoux.net/if/user/#/settings`
- « Administration » → `https://auth.payoux.net/if/admin/` (admins only)
- « Se déconnecter » → sign-out action

Search (client-side, over the already-filtered list):

- `normalize(s) = s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()`.
- A service matches when the normalised query is a substring of its normalised name, description or section.
- `/` focuses the input unless focus is already in an input or textarea.
- `Esc` clears the query and blurs the input.
- `Enter` opens the first visible result.
- Sections with no match are hidden; no match at all → « Aucun résultat pour « <query> » ».

## Errors

| Case | Behaviour |
|---|---|
| `services.yml` invalid, good version cached | Serve the good version, log the error |
| Invalid or missing, nothing cached | Page shows « La liste des services est momentanément indisponible. », HTTP 500, error logged |
| Service references an unknown section | Validation error, as above |
| User in none of the listed groups | « Aucun service pour l’instant. », user menu still shown |
| Authentik unreachable at sign-in | Auth.js default error page |
| Icon file missing | 404 → initial tile |
| Invalid icon name | 400 |

## Tests

Vitest:

- `visibility`: single group, union of groups, no group, `dimmed` for each reach × origin, section order, empty sections dropped, `isAdmin`.
- `origin`: `lan`, `internet`, missing, junk value.
- `search`: « camera » matches « Caméra », match on section and description, empty query matches all.
- `services`: valid file, invalid file with cached good version, invalid file with nothing cached, reload on mtime change (temp directory fixtures).
- Icon route name validation.

Playwright, against `next dev` with fixture `services.yml` and icons directory:

- `DEV_USER_GROUPS=family`, `DEV_ORIGIN=internet`: only family cards; LAN-only family cards dimmed with the hint; no « Administration » in the menu.
- `DEV_USER_GROUPS=family,authentik Admins`, `DEV_ORIGIN=lan`: admin cards visible; nothing dimmed; « Administration » present.
- Search: `/` focuses, typing « camera » filters to Frigate, `Esc` clears, `Enter` navigates to the first result.

The production checks of the brief's test matrix (forged header overwritten through the tunnel, Authentik session ended on sign-out, 4G vs LAN) are run by hand after deployment.

## Delivery

Dockerfile: multi-stage on `node:24-alpine`; build stage runs `npm ci` and `next build`; runtime stage copies `.next/standalone`, `.next/static`, `scripts/` and runs `node server.js` as user `node` on port 3000. No secrets and no `services.yml` in the image.

`.github/workflows/build.yml`:

- Every push and pull request: `npm ci`, lint, typecheck, Vitest.
- Push to `main`: Playwright, then build and push `ghcr.io/rykian/portail:latest` and `:sha-<short sha>` using `GITHUB_TOKEN`. The package is public, so CT 100 pulls without logging in.

`deploy/compose.yml` (template for `/root/portal/` on CT 100):

```yaml
services:
  portal:
    image: ghcr.io/rykian/portail:latest
    restart: unless-stopped
    env_file: .env
    environment:
      SERVICES_FILE: /data/services.yml
      ICONS_DIR: /data/icons
    volumes:
      - ./data:/data:ro    # services.yml + icons/; a directory, not a file mount (see below)
    networks: [proxy]

networks:
  proxy:
    external: true
```

`/root/portal/data/` holds `services.yml` and `icons/`. The directory is mounted rather than the single file because editors that save by replacing the file (new inode) would leave a single-file bind mount pointing at the old content, and the mtime reload would never fire.

Update on CT 100: `docker compose pull && docker compose up -d`. What's Up Docker reports new images.
