# Full-Bun Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repo to Bun only (package manager and runtime, portal image included) and to a Bun-workspaces layout `apps/portail`, `apps/updater`, `packages/shared`, with no behaviour change.

**Architecture:** A throwaway spike first proves the Next standalone server runs under Bun. Then three commits on one branch: npm → Bun on the current layout, the `git mv` into workspaces with a real `@portail/shared` package, then Dockerfiles/CI/docs on the new layout. Verified locally (e2e, image builds, smoke test) before a single merge to `main`.

**Tech Stack:** Bun 1.4.4 (workspaces, `--filter`), Next.js 16.4.3 (`output: "standalone"`, Turbopack), NestJS 12.2, vitest 5 (`bun --bun vitest run`), Playwright 1.64, oxlint/oxfmt, Docker, GitHub Actions (`oven-sh/setup-bun@v2`).

**Spec:** `docs/superpowers/specs/2026-10-25-bun-monorepo-design.md`

## Global Constraints

- No product or behaviour change. Application code changes only for import paths or a `node` invocation. No dependency upgrades beyond what the switch forces.
- Bun pinned to `1.4.4` everywhere: root `packageManager: "bun@1.4.4"`, CI `bun-version: 1.4.4`, `oven/bun:1.4.4` in both Dockerfiles.
- No `node`, `npx`, `npm` left in scripts, configs, Dockerfiles, CI or README, except Playwright's own runner falling back to Node (tolerated).
- No Turborepo/Nx. Root scripts use `bun run --filter`.
- Unchanged: `deploy/*.yml`, container paths (`/data`, `/data/services.yml`, `/data/icons`), ports (portal 3000, updater 8080), env vars, image names `ghcr.io/rykian/portail` and `ghcr.io/rykian/portail-updater`, CI job names and triggers (e2e/image jobs only on push to `main`).
- Files are moved with `git mv` so `git log --follow` works.
- No test-only auth seam: e2e keeps running against `bun --bun next dev` with `x-dev-user-groups`.
- **Smoke test** (portal, production build): with the server on `$BASE`,
  `curl -s -o /dev/null -w '%{http_code}' $BASE/favicon.ico` → `200`;
  `curl -s -o /dev/null -w '%{http_code}' $BASE/auth-error` → `200`;
  `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' $BASE/` → `307 …/login?callbackUrl=%2F`.
  Server env: `AUTH_SECRET=smoke-only-not-a-secret`, `SERVICES_FILE`/`ICONS_DIR` pointing at the e2e fixtures (absolute paths, or a mount at `/data` for the image).
- Work on branch `bun-monorepo`. Each commit passes `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`. Commit steps run only if your human partner authorised commits for this execution; otherwise skip them.
- Comments in English, matching the existing density.

## Review Focus

1. **Turbopack resolving `@portail/shared` TypeScript sources through a symlinked workspace** — server and client imports in `lib/` must build and run in dev and in the standalone build. → Task 3 verification runs `bun run build` and the e2e suite; Task 4 smoke test on the image.
2. **Standalone tracing in a monorepo** — `server.js` lands under `.next/standalone/apps/portail/`, and `yaml` (for `fetch-icons.mjs`) and `@portail/shared` must be inside the traced output. → Task 3 step "standalone layout check", Task 4 runs `fetch-icons.mjs` inside the image.
3. **`bun install --frozen-lockfile --filter` in Docker** with only some workspaces' sources present — must not rewrite or reject the lockfile. → Task 4 builds both images from a clean context.
4. **Dev auth under Bun** — `NODE_ENV` must be `development` under `bun --bun next dev`, or every e2e spec redirects to `/login`. → Task 2 runs the full e2e suite.
5. **File ownership in the portal image** — `oven/bun` runs as user `bun`; the `/data` mount is read-only and `fetch-icons` writes `/data/icons` only through an explicit rw mount. → Task 4 image check runs `fetch-icons.mjs` as the image user against a writable temp dir.

---

### Task 1: Spike — Next standalone under Bun (throwaway)

No commit, nothing kept. Run in a scratch worktree: `git worktree add <scratchpad>/spike main`.

**Files:** none kept.

- [ ] **Step 1: Install and build with Bun.** In the worktree: `rm package-lock.json && bun install`, then `bun --bun next build`. Expected: build succeeds, `.next/standalone/server.js` exists.
- [ ] **Step 2: Start standalone under Bun.** `cp -r .next/static .next/standalone/.next/static`, then from `.next/standalone`: `PORT=3200 HOSTNAME=127.0.0.1 AUTH_SECRET=smoke-only-not-a-secret SERVICES_FILE=<worktree>/e2e/fixtures/services.yml ICONS_DIR=<worktree>/e2e/fixtures/icons bun server.js` (background). Expected: listens on 3200, no crash.
- [ ] **Step 3: Smoke test** with `BASE=http://127.0.0.1:3200` (Global Constraints). Expected: `200`, `200`, `307 …/login?callbackUrl=%2F`.
- [ ] **Step 4: `fetch-icons.mjs` from the traced output.** `mkdir .next/standalone/scripts && cp scripts/fetch-icons.mjs .next/standalone/scripts/`, then from `.next/standalone`: `SERVICES_FILE=<worktree>/e2e/fixtures/services.yml ICONS_DIR=$(mktemp -d) bun scripts/fetch-icons.mjs`. Expected: resolves `yaml`, exits 0 (download errors for unknown slugs are fine; a module-not-found is not).
- [ ] **Step 5: Gate.** All green → remove the worktree, continue. Anything failing that a config change can't fix within the spike → **stop and report to your human partner**; the "no Node in production" goal is re-discussed before Task 2.

---

### Task 2: npm → Bun on the current layout

**Files:**
- Modify: `package.json`, `playwright.config.ts:40-48`, `e2e/fake-updater.mts:1`, `Dockerfile`, `.github/workflows/ci.yml` (`check`, `e2e` jobs), `.oxfmtrc.json`, `README.md` (Développement and Déploiement blocks)
- Create: `bun.lock`
- Delete: `package-lock.json`

**Interfaces:**
- Produces: root scripts `dev`, `build`, `start`, `lint`, `format`, `format:check`, `typecheck`, `test`, `e2e`, `fetch-icons` all runnable with `bun run <name>`. Portal image runs `bun server.js` as user `bun`.

- [ ] **Step 1: Switch the lockfile.** `git rm package-lock.json`, `bun install`. Expected: `bun.lock` created; `git diff package.json` shows no dependency version change.
- [ ] **Step 2: Scripts.** In `package.json`: `dev` → `bun --bun next dev`, `build` → `bun --bun next build`, `start` → `bun --bun next start`, `test` → `bun --bun vitest run`, `fetch-icons` → `bun scripts/fetch-icons.mjs`; add `"packageManager": "bun@1.4.4"`. Others unchanged.
- [ ] **Step 3: Run unit checks.** `bun run lint && bun run format:check && bun run typecheck && bun run test`. Expected: all pass, same test count as `npm test` on `main` (record it first).
- [ ] **Step 4: Playwright on Bun.** `playwright.config.ts` webServer commands: `bun e2e/fake-updater.mts` and `` `bun --bun next dev -p ${port}` ``. Update the comment on line 1 of `e2e/fake-updater.mts` to `` `bun e2e/fake-updater.mts` `` (drop "Node strips the types").
- [ ] **Step 5: Run e2e.** `bunx playwright install chromium && bun run e2e`. Expected: every project passes (this also proves dev auth works under Bun, Review Focus 4).
- [ ] **Step 6: Portal Dockerfile on `oven/bun:1.4.4`.** Three stages kept: deps (`COPY package.json bun.lock`, `bun install --frozen-lockfile`), build (`bun run build`), runtime (copy standalone, static, `scripts/fetch-icons.mjs` as now, `--chown=bun:bun`, `USER bun`, `CMD ["bun", "server.js"]`). ENV, `EXPOSE 3000` unchanged.
- [ ] **Step 7: Image check.** `docker build -t portail:bun .`, run with `-p 3300:3000 -e AUTH_SECRET=smoke-only-not-a-secret -v $PWD/e2e/fixtures:/data:ro`, smoke test with `BASE=http://127.0.0.1:3300`. Expected: `200`, `200`, `307 …/login?callbackUrl=%2F`.
- [ ] **Step 8: CI and config.** `check` and `e2e` jobs: replace `setup-node` with `oven-sh/setup-bun@v2` (`bun-version: 1.4.4`), `npm ci` → `bun ci`, `npm run x` / `npm test` → `bun run x`, `npx playwright install --with-deps chromium` → `bunx playwright install --with-deps chromium`. `.oxfmtrc.json` ignore: `package-lock.json` → `bun.lock`.
- [ ] **Step 9: README.** Développement block uses `bun install` / `bun run …`; the icons command becomes `… portal bun scripts/fetch-icons.mjs`; the last line of the updater section says `bun run test` at the root instead of `npm test`.
- [ ] **Step 10: Re-run** Step 3 commands. Expected: pass. `grep -rnE '\b(npm|npx|node) ' package.json playwright.config.ts Dockerfile .github README.md e2e` → no output except `.github` lines for the `updater` job, which Task 4 rewrites.
- [ ] **Step 11: Commit** — `chore: switch the portal to Bun`.

---

### Task 3: Workspaces layout and `@portail/shared`

**Files:**
- Move (`git mv`): portal files → `apps/portail/` (`app/`, `components/`, `lib/`, `e2e/`, `scripts/`, `types/`, `auth.ts`, `proxy.ts`, `proxy.test.ts`, `next.config.ts`, `playwright.config.ts`, `vitest.config.ts`, `tsconfig.json`, `components.json`, `services.example.yml`, `.env.development`, `package.json`, `AGENTS.md`, `Dockerfile`, `.dockerignore`); `updater/*` → `apps/updater/`; `shared/*` → `packages/shared/`
- Create: root `package.json`, `bunfig.toml`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`
- Modify: `apps/portail/package.json`, `apps/portail/next.config.ts`, `apps/portail/tsconfig.json`, `apps/portail/vitest.config.ts`, `apps/updater/package.json`, `apps/updater/tsconfig.json`, `apps/updater/vitest.config.ts`, every importer of the shared contract (4 in `apps/portail/lib/`, 6 in `apps/updater/src/`), `.oxlintrc.json`, `.oxfmtrc.json`, `.gitignore`
- Delete: `apps/updater/bun.lock` (after move), `apps/updater/node_modules`, root `node_modules` (reinstall)

**Interfaces:**
- Consumes: Task 2 scripts.
- Produces: package `@portail/shared` exporting `./updater-api` → `./updater-api.ts` (TS source, no build step). Workspace names `portail`, `updater`, `@portail/shared`, each with `typecheck` and `test` scripts. Root scripts `lint`, `format`, `format:check`, `typecheck`, `test`, `e2e`, `dev`. Standalone server at `apps/portail/.next/standalone/apps/portail/server.js`.

- [ ] **Step 1: Move.** `git mv` as listed. Ignored files (`data/`, `.next/`, `test-results/`, `updater/data/`) move by hand. Expected: `git status` shows renames, no deletes+adds for moved files.
- [ ] **Step 2: Root workspace.** Root `package.json`: `name: "payoux"`, `private`, `workspaces: ["apps/*", "packages/*"]`, `packageManager: "bun@1.4.4"`, devDependencies `oxlint` and `oxfmt` (moved from the portal, same versions), scripts: `dev` → `bun run --filter portail dev`, `lint` → `oxlint`, `format` → `oxfmt`, `format:check` → `oxfmt --check`, `typecheck` → `bun run --filter '*' typecheck`, `test` → `bun run --filter '*' test`, `e2e` → `bun run --filter portail e2e`. `bunfig.toml`: `[install] linker = "hoisted"` (predictable `node_modules` for Next tracing and the Docker stages). Portal `package.json`: drop `lint`/`format*` scripts and oxlint/oxfmt devDeps, add `"@portail/shared": "workspace:*"`. Updater `package.json`: add `"@portail/shared": "workspace:*"`, drop `packageManager`.
- [ ] **Step 3: `@portail/shared`.** `package.json`: `name`, `private`, `type: "module"`, `exports: { "./updater-api": "./updater-api.ts" }`, dependency `zod: "4.6.7"`, devDeps `typescript`, `vitest` (versions as in the portal), scripts `typecheck: "tsc --noEmit"`, `test: "bun --bun vitest run"`. `tsconfig.json`: strict, `module: "preserve"`, `moduleResolution: "bundler"`, `noEmit`, `skipLibCheck`. `vitest.config.ts`: `include: ["*.test.ts"]`.
- [ ] **Step 4: Rewrite imports.** `@/shared/updater-api` and `@shared/updater-api` → `@portail/shared/updater-api`. Remove: updater tsconfig `paths` (both entries) and `"../shared"` from `include`/`exclude`; updater vitest `resolve.alias` (both entries; drop the block and unused imports); portal tsconfig `"updater"` in `exclude`; portal vitest `"shared/**/*.test.ts"` include. Portal `next.config.ts`: add `transpilePackages: ["@portail/shared"]`, `outputFileTracingRoot` = repo root (`path.join(import.meta.dirname, "../..")`), and tracing include → `"../../node_modules/yaml/**"` (keep the comment).
- [ ] **Step 5: Lint/format configs and ignores.** `.oxlintrc.json` `ignorePatterns`: `**/.next/**`, `**/out/**`, `**/build/**`, `**/next-env.d.ts`. `.oxfmtrc.json` ignore: drop `updater/bun.lock`. `.gitignore`: `/node_modules` → `node_modules/`, `/.next/` → `.next/`, `/out/` → `out/`, `/data/` → `/apps/portail/data/`, `/test-results/` and `/playwright-report/` under `/apps/portail/`, `/updater/node_modules/` removed, `/updater/data/` → `/apps/updater/data/`.
- [ ] **Step 6: Reinstall.** `rm -rf node_modules apps/*/node_modules apps/updater/bun.lock && bun install`. Expected: one root `bun.lock`; `node_modules/@portail/shared` is a symlink to `packages/shared`.
- [ ] **Step 7: Run checks from the root.** `bun run lint && bun run format:check && bun run typecheck && bun run test`. Expected: all pass; total test count equals Task 2's portal count + updater count (shared tests now counted under `@portail/shared`).
- [ ] **Step 8: Build and e2e.** `bun run --filter portail build`, then `bun run e2e`. Expected: build succeeds, every e2e project passes (Review Focus 1).
- [ ] **Step 9: Standalone layout check.** Expected: `apps/portail/.next/standalone/apps/portail/server.js` exists, `apps/portail/.next/standalone/node_modules/yaml` exists. Start it as in Task 1 Step 2 (static copied to `.next/standalone/apps/portail/.next/static`) and run the smoke test. Expected: `200`, `200`, `307 …/login?callbackUrl=%2F` (Review Focus 2).
- [ ] **Step 10: History.** `git log --follow --oneline apps/portail/lib/updater.ts | wc -l` > 1 and same for `packages/shared/updater-api.ts`.
- [ ] **Step 11: Commit** — `refactor: move to Bun workspaces (apps/, packages/)`. Dockerfiles and CI are broken by this commit until Task 4 (both land in the same merge).

---

### Task 4: Dockerfiles, CI and docs on the new layout

**Files:**
- Modify: `apps/portail/Dockerfile`, `apps/updater/Dockerfile`, `.github/workflows/ci.yml`, `README.md`
- Create: `apps/portail/Dockerfile.dockerignore`
- Modify: `apps/updater/Dockerfile.dockerignore`
- Delete: `apps/portail/.dockerignore`

**Interfaces:**
- Consumes: Task 3 workspace names, standalone path `.next/standalone/apps/portail/server.js`.
- Produces: both images built with the repo root as context and `-f apps/<app>/Dockerfile`.

- [ ] **Step 1: Portal Dockerfile.** deps stage: copy root `package.json`, `bun.lock`, `bunfig.toml` and all three workspace `package.json` files (the lockfile check needs every workspace manifest), `bun install --frozen-lockfile --filter portail`. build stage: copy `apps/portail` and `packages/shared` sources, `bun run build` in `/app/apps/portail`. runtime: standalone → `/app`, static → `/app/apps/portail/.next/static`, `fetch-icons.mjs` → `/app/apps/portail/scripts/`, `WORKDIR /app/apps/portail`, `USER bun`, `CMD ["bun", "server.js"]`. ENV/EXPOSE as in Task 2.
- [ ] **Step 2: `apps/portail/Dockerfile.dockerignore`** — whitelist like the updater's: `*`, then un-ignore root `package.json`, `bun.lock`, `bunfig.toml`, the three workspace manifests, `apps/portail` and `packages/shared`; re-ignore `**/node_modules`, `**/.next`, `apps/portail/data`, `apps/portail/e2e`, `apps/portail/test-results`, `**/*.test.ts`, `**/.env*` (the build reads no env file). Delete `apps/portail/.dockerignore`.
- [ ] **Step 3: Updater Dockerfile.** deps stage: same manifests as Step 1, `bun install --frozen-lockfile --production --filter updater`. runtime: `COPY --from=deps /app /app` (keeps any nested `node_modules` and the `@portail/shared` symlink), copy `apps/updater/{package.json,tsconfig.json,src}` and `packages/shared`, `WORKDIR /app/apps/updater`, Docker CLI copies, ENV, `EXPOSE 8080`, `CMD ["bun", "src/main.ts"]` unchanged. The `ln -s` line and its comment are removed. `Dockerfile.dockerignore`: same whitelist idea with `apps/updater` paths; `apps/updater/src/test` and `**/*.test.ts` still excluded.
- [ ] **Step 4: Image checks.** From the root: `docker build -f apps/portail/Dockerfile -t portail:mono .` and `docker build -f apps/updater/Dockerfile -t updater:mono .` (Review Focus 3). Portal: run as in Task 2 Step 7, smoke test → `200`, `200`, `307 …/login?callbackUrl=%2F`; then `docker run --rm -e SERVICES_FILE=/data/services.yml -v $PWD/apps/portail/e2e/fixtures:/data:ro -v $(mktemp -d):/data/icons portail:mono bun scripts/fetch-icons.mjs` → exits 0, no module-not-found (Review Focus 2, 5). Updater: `docker run --rm -d -p 3301:8080 -e UPDATER_TOKEN=x -e UPDATER_DATA=/tmp updater:mono`, `curl -s localhost:3301/health` → 200; without `UPDATER_TOKEN` the container exits 1 with `UPDATER_TOKEN est requis`.
- [ ] **Step 5: CI.** `check`: root `bun ci`, `bun run lint`, `bun run format:check`, `bun run --filter portail --filter @portail/shared typecheck`, same filters for `test`. `updater`: drop `working-directory`, root `bun ci`, `bun run --filter updater typecheck`, `bun run --filter updater test`. `e2e`: unchanged commands from Task 2 (root `bun run e2e`). `image`: `file: apps/portail/Dockerfile`; `image-updater`: `file: apps/updater/Dockerfile`; both keep `context: .`, tags, triggers.
- [ ] **Step 6: README.** Développement: run from the repo root (`bun install`, `mkdir -p apps/portail/data/icons && cp apps/portail/services.example.yml apps/portail/data/services.yml`, `bun run dev|lint|format|test|e2e`); updater dev block → `bun run --filter updater test|typecheck` from the root; drop the "tests de `shared/` tournent dans la suite racine" line; design links and `updater/` mentions → `apps/updater/`. Add one line on the layout (`apps/portail`, `apps/updater`, `packages/shared`).
- [ ] **Step 7: Final checks.** `bun run lint && bun run format:check && bun run typecheck && bun run test && bun run e2e` → pass. `grep -rnE '\b(npm|npx|node) ' package.json apps/*/package.json apps/*/Dockerfile apps/portail/playwright.config.ts .github README.md` → no output. `git ls-files | grep -E 'package-lock|updater/bun.lock'` → no output.
- [ ] **Step 8: Commit** — `build: Dockerfiles and CI for the Bun workspaces`. Then hand back for the merge to `main` (one merge, one pair of `:latest` images).
