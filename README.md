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

## Mises à jour des conteneurs (updater)

Le service `updater/` (NestJS sur Bun) détecte et applique les mises à jour des stacks compose de CT 100. Le portail n'est que l'interface (admins uniquement) et lui parle côté serveur via `UPDATER_URL` / `UPDATER_TOKEN`.

Design: `docs/superpowers/specs/2026-10-24-container-updater-design.md`.

### Déploiement (CT 100 uniquement)

L'updater a `docker.sock` et `/root` : c'est un accès équivalent à root. Il ne tourne que sur CT 100 et n'est pas exposé sur le réseau `proxy` (seul le réseau interne `updater` le relie au portail).

1. Créer `/root/updater/` avec `compose.yml` (depuis `deploy/updater-compose.yml`), `.env` (`UPDATER_TOKEN=<secret>`), `config.yml` (depuis `deploy/updater-config.example.yml`) et `data/`.
2. Démarrer l'updater en premier, il crée le réseau `updater` : `docker compose up -d`.
3. Ajouter le même `UPDATER_TOKEN` au `.env` du portail (`/root/portal/`), mettre à jour son `compose.yml` (`deploy/compose.yml`) puis `docker compose up -d`.

Variables de l'updater : `UPDATER_TOKEN` (obligatoire), `PORT` (8080), `UPDATER_ROOT` (`/root`), `UPDATER_CONFIG` (`/root/updater/config.yml`), `UPDATER_DATA` (`/data`). `GET /health` ne demande pas de jeton.

### Configuration (`config.yml`)

Relu à chaque vérification ; un fichier invalide est signalé dans l'interface et la dernière configuration valide est conservée. Les stacks sont découvertes automatiquement (`/root/<stack>/`) ; `exclude` liste les répertoires ignorés (`*` seul joker). Clés par stack :

| Clé                 | Rôle                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `version`           | La version est dans une variable : `file` (relatif à la stack) et `variable`. La mise à jour ne réécrit que cette ligne. |
| `recipe`            | Procédure intégrée (seulement `authentik`) ; exige `version`.                                                            |
| `confirm`           | Demande une confirmation explicite et est exclue de « Tout mettre à jour ».                                              |
| `last`              | Mise à jour à la fin de « Tout mettre à jour » (stacks qui coupent l'accès au portail).                                  |
| `before`            | Commandes shell lancées dans le répertoire de la stack avant la mise à jour ; un code de sortie non nul fait échouer.    |
| `beforeOnlyOnMajor` | Ne lance `before` que pour un changement de version majeure (toujours si la version est inconnue).                       |

Les commandes `before` s'exécutent dans le conteneur de l'updater (`sh -c`), pas sur l'hôte : l'image fournit `sh`, `tar`, `gzip` et le CLI Docker avec le plugin compose. Pour utiliser un outil d'un conteneur de la stack, passer par `docker compose exec -T`.

### Développement

```bash
cd updater && bun install
bun run test           # Vitest
bun run typecheck
```
