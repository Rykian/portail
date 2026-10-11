# Portail

Page d'accueil de `https://payoux.net` : liste des services de la maison, filtrée par groupe Authentik.

Design: `docs/superpowers/specs/2026-10-11-portail-design.md`.

## Développement

```bash
npm install
mkdir -p data/icons && cp services.example.yml data/services.yml
npm run dev            # fake user from .env.development, no Authentik needed
npm run lint           # oxlint
npm run format         # oxfmt
npm test               # Vitest
npm run e2e            # Playwright
```

`DEV_USER_GROUPS` (`.env.development`) sets the fake user's groups; `DEV_ORIGIN=internet` simulates a visit from outside.

## Déploiement (CT 100)

`/root/portal/` contains `compose.yml` (from `deploy/compose.yml`), `.env` (the `AUTH_*` variables) and `data/` (`services.yml` + `icons/`).

```bash
docker compose pull && docker compose up -d        # update
docker compose run --rm -v ./data/icons:/data/icons portal node scripts/fetch-icons.mjs   # new icons
```

Edits to `data/services.yml` are picked up on the next page load. Admins must also be in the `family` group to see family entries.
