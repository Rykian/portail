# Container Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin see, apply and roll back Docker Compose stack updates on CT 100 from the portal, through a separate « updater » service that alone owns Docker access.

**Architecture:** `updater/` is a NestJS app on the Bun runtime. Its domain logic (discovery, config, version maths, detection, jobs, updates, rollback, Authentik recipe) is plain TypeScript behind two interfaces, `Docker` (shells out to the `docker` CLI) and `Registry` (registry HTTP API v2), so it is unit-tested with fakes. Nest controllers are thin. State lives in `bun:sqlite`. Zod schemas for the HTTP API live once in `shared/updater-api.ts` and are imported by both apps. The portal (Next.js, Node, npm, unchanged toolchain) gets a server-side client, an admin-only catch-all proxy route `/api/updates/[...path]` (SSE included), a badge, and the page `/admin/updates`.

**Tech Stack:** Bun 1.4, NestJS 12 (`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`, `@nestjs/testing`), `reflect-metadata`, `rxjs`, zod 4, ts-pattern 5, remeda 2, `yaml` 2, `diff` (jsdiff), Vitest 5 run with `bun --bun vitest`, TypeScript 7. Portal: Next.js 16.4, React 19.3, shadcn on Base UI, Playwright 1.64. Docker CLI + compose plugin copied from `docker:29-cli`. GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-10-24-container-updater-design.md`

## Global Constraints

- Updater: Bun runtime and package manager (`updater/package.json`, `updater/bun.lock`). Portal stays Node 24 + npm (`package-lock.json`); no portal toolchain change.
- `shared/updater-api.ts` imports only `zod`. No Bun, Node or Nest import there. `zod` is pinned to the same exact version (no `^`) in `package.json` and `updater/package.json`.
- Every constructor parameter of a Nest provider or controller uses an explicit `@Inject(TOKEN)`. Vitest does not emit decorator metadata; explicit tokens make DI work in tests and at runtime alike.
- Use ts-pattern `match(...).exhaustive()` when branching on a discriminated union (update mode, service kind, job kind, job event, container state). Use remeda for sorting, grouping and filtering collections (`sortBy`, `groupBy`, `partition`, `uniqueBy`…) instead of hand-rolled loops.
- Updater env: `UPDATER_TOKEN` (required), `PORT` (default `8080`), `UPDATER_ROOT` (default `/root`), `UPDATER_CONFIG` (default `/root/updater/config.yml`), `UPDATER_DATA` (default `/data`; SQLite file `updater.db` inside).
- Portal env: `UPDATER_URL` (e.g. `http://updater:8080`), `UPDATER_TOKEN`. Missing `UPDATER_URL` = updater disabled: no badge, page says unreachable.
- Headers: `Authorization: Bearer <UPDATER_TOKEN>` on every request except `GET /health`; `X-Updater-User: <email>` on POSTs.
- Compose file names, in this order: `compose.yml`, `compose.yaml`, `docker-compose.yml`, `docker-compose.yaml`.
- The stack named `updater` is always excluded, whatever the config says.
- Rollback image tag: `updater-rollback/<project>-<service>:latest`.
- Health wait: 60 s deadline, poll every 2 s.
- Check schedule: every 6 h. Logs deleted 90 days after the job ended; job metadata kept forever.
- Authentik upstream URL: `https://goauthentik.io/version/<YYYY.M>/lifecycle/container/compose.yml`.
- Portal badge fetch timeout: 1 000 ms. Badge count = number of stacks with `update: true`.
- Image: `ghcr.io/rykian/portail-updater`, tags `latest` and `sha-<short>`, built on push to main.
- UI copy (French, verbatim from the spec): « Mises à jour », « Mises à jour (N) », « Tout mettre à jour », « Vérifier maintenant », « Vérifié il y a … » (e.g. « Vérifié il y a 2 h »), « Historique », « nouvelles images », « nouvelle image du <date> », « nouvelle version disponible : <a> → <b> », « Passer la version dans une variable pour l'activer », « Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml », « non lancées », « interrompue », « Revenir à <version> ». Secondary strings: French, implementer's wording.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js code (route handlers, `notFound`, dynamic params are Promises in Next 16).

**Dependency versions:** install `@latest`. Checked 2026-10-24:

| Package / tool | Latest | Note |
|---|---|---|
| Bun | 1.4.4 | Local machine has 1.3.10: run `bun upgrade` first. Pin `oven/bun:1.4.4` and `bun-version: 1.4.4`. |
| `@nestjs/core`, `common`, `platform-express`, `testing` | 12.2.0 | Read Nest 12's migration notes once; if it requires ESM-only or a different SSE API, follow Nest's docs. |
| `ts-pattern` | 5.9.2 | |
| `remeda` | 2.53.0 | |
| `zod` | 4.6.7 | Pin exactly in both `package.json` files (portal currently `^4.6.5`). |
| `yaml` | 2.9.1 | |
| `reflect-metadata` | 0.2.2 | |
| `rxjs` | 7.8.2 | |
| `@types/bun` | 1.4.4 | |
| `vitest` | 5.0.5 | |
| `oven-sh/setup-bun` | v2 | |

A breaking change that affects this plan is a stop-and-report, not a silent downgrade. If TypeScript 7 rejects `experimentalDecorators`/`emitDecoratorMetadata`, pin `typescript@^6` in `updater/` and say so in the commit.

**Decisions taken while planning (spec left them open or implied):**

1. Registry access: direct HTTP API v2 with `fetch` (anonymous bearer-token challenge), no `regctl`/`skopeo`.
2. Docker access: `docker` CLI for everything (`docker compose config --format json` with and without `--no-interpolate`, `docker compose ps -a --format json`, `docker inspect`, `docker image inspect`, `docker image tag`, `docker image rm`).
3. A service's *kind*: image raw string contains `${<version.variable>` → `variable`; image pinned by `@sha256:` → `pinned` (never updated); tag matches `/^v?\d+\.\d+\.\d+/` → `literal`; anything else (including no tag = `latest`) → `floating`.
4. The update button exists when at least one service with an update is not `literal` or `pinned`.
5. `needsConfirm` = config `confirm` || major bump || Authentik minor change. `POST /stacks/:name/update` without `{confirm: true}` on such a stack does not start: it answers `{ needsConfirm: { from, to, diff, warning } }`. `diff` is set only for the Authentik minor; `warning` (rollback may fail, vzdump is the safety net) is set for stacks with `confirm` or `recipe`.
6. Authentik: if a newer patch exists in the current minor, that is the offered update (plain variable update, no confirm). Otherwise the next minor's latest patch, through the recipe. A stack with `recipe` is ordered with the `last` stacks in « Tout mettre à jour ».
7. After every successful update or rollback step, the job re-checks that stack, so the badge drops without waiting 6 h. A successful rollback deletes the stack's rollback state and tags.
8. Admins always see the « Mises à jour » menu entry; the count is appended when N > 0.
9. Shared schema location: `shared/` at the repo root. In the image, `/app/node_modules` is a symlink to `/app/updater/node_modules` so `shared/` resolves the updater's zod.
10. `POST /stacks/:name/update` on a stack whose button is off, or with no update: `400 { error }`. Busy: `409 { error: "Une tâche est déjà en cours" }`. Unknown stack or job: `404`.

## Review Focus

1. `.env` formatting the admin wrote by hand (`export VERSION=…`, `VERSION="v3.4.0"`, `VERSION='…'`, CRLF line endings, trailing comment, no final newline, variable defined twice) → only the value of the last definition changes, quoting and every other byte are kept. A missing variable fails the update before any file changes. (Tests in Task 5.)
2. One registry failing (timeout, `429`, `404` for a private image, unparseable response) → that service carries an `error`, every other service and stack is still checked, and the check job succeeds. (Test in Task 8.)
3. A stack whose `docker compose config` fails (broken YAML, missing env file) → the stack is listed with `error` and no button; an update started on a stack that broke since the last check fails with the compose output in the log, and nothing was rewritten. (Tests in Tasks 8 and 11.)
4. Image references without a tag, with a port in the registry host (`registry:5000/x`), or pinned by digest (`x@sha256:…`) → parsed correctly; no tag = `latest`; digest-pinned = `pinned`, never updated, no crash. (Tests in Tasks 4 and 8.)
5. The browser's EventSource reconnects (portal or updater restarted mid-job) and the server replays the log from the start → the log panel shows each line once (it clears on every `open`); a stream for a finished job replays then ends; an unknown job is `404`; a job running when the updater restarted shows « interrompue ». (Tests in Tasks 9, 14 and 17.)

---

## File structure

```
shared/updater-api.ts            zod schemas + types of the HTTP API (single source)
shared/updater-api.test.ts       (runs in the portal's Vitest)
updater/
  package.json  bun.lock  tsconfig.json  vitest.config.ts  Dockerfile  Dockerfile.dockerignore
  src/
    main.ts                      bootstrap: env, store, markInterrupted, Nest app, scheduler
    config.ts                    config.yml schema + loader (keeps last valid)
    discovery.ts                 list /root/* stacks
    versions.ts                  tag shape, compare, major, Authentik target
    image-ref.ts                 parse image references
    env-file.ts                  read / rewrite one variable in .env
    registry.ts                  Registry interface + HTTP v2 client
    docker.ts                    Docker interface + types
    docker-cli.ts                Docker implementation (Bun.spawn)
    store.ts                     bun:sqlite persistence
    detection.ts                 checkStack / checkAll
    jobs.ts                      JobRunner (one job at a time, logs, events)
    health.ts                    evaluateHealth / waitHealthy
    update.ts                    updateStack / rollbackStack (pull, variable)
    authentik.ts                 Authentik recipe
    update-all.ts                planUpdateAll / runUpdateAll
    service.ts                   UpdaterService: glue used by controllers and scheduler
    http/app.module.ts  http/tokens.ts  http/auth.guard.ts  http/controllers.ts
    scheduler.ts
    test/fakes.ts                FakeDocker, FakeRegistry, tmp dirs
lib/updater.ts (+ .test.ts)      portal server-side client
lib/relative-time.ts (+ .test.ts)
app/api/updates/[...path]/route.ts
app/admin/updates/page.tsx
components/updates/*.tsx
e2e/fake-updater.ts  e2e/updates.spec.ts
deploy/updater-compose.yml  deploy/updater-config.example.yml
```

---

### Task 1: Updater toolchain scaffold

**Files:**
- Create: `updater/package.json`, `updater/tsconfig.json`, `updater/vitest.config.ts`, `updater/src/smoke.test.ts` (deleted in Step 6)
- Modify: `package.json` (pin zod), `tsconfig.json` (exclude `updater`), `vitest.config.ts` (include `shared/**/*.test.ts`), `.gitignore`, `.oxfmtrc.json`, `.dockerignore`

**Interfaces:**
- Produces: `cd updater && bun run typecheck | test | dev | start`; import alias `@shared/*` → `../shared/*` inside the updater; `zod` resolved to `updater/node_modules/zod` for every file the updater compiles or tests.

- [ ] **Step 1: Upgrade Bun and create the package**

```bash
bun upgrade && bun --version          # expect 1.4.x
mkdir -p updater/src shared && cd updater && bun init -y
bun add @nestjs/core @nestjs/common @nestjs/platform-express reflect-metadata rxjs ts-pattern remeda yaml diff zod@4.6.7 --exact
bun add -d @nestjs/testing @types/bun @types/diff typescript vitest
```

Remove files `bun init` created that this plan does not use (`index.ts`, its README). Set `"packageManager": "bun@1.4.4"` and scripts:

```json
{ "dev": "bun --watch src/main.ts", "start": "bun src/main.ts", "typecheck": "tsc --noEmit", "test": "bun --bun vitest run" }
```

- [ ] **Step 2: `updater/tsconfig.json` and `updater/vitest.config.ts`**

tsconfig: `strict`, `module`/`moduleResolution` `"preserve"`/`"bundler"`, `target` `"esnext"`, `types: ["bun"]`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `noEmit: true`, `include: ["src", "../shared"]`, `paths: { "@shared/*": ["../shared/*"], "zod": ["./node_modules/zod"] }`.

vitest.config: `resolve.alias` `@shared` → `../shared`, `zod` → `./node_modules/zod` (absolute via `fileURLToPath`, as in the root config); `test.include: ["src/**/*.test.ts"]`. If Vitest fails to load `bun:sqlite`, add it to `server.deps.external` / `ssr.external`.

- [ ] **Step 3: Write the smoke test**

```ts
// updater/src/smoke.test.ts
import { Database } from "bun:sqlite";
import { match } from "ts-pattern";
import { z } from "zod";
test("bun runtime, sqlite, ts-pattern, zod", () => {
  const db = new Database(":memory:");
  expect(db.query("select 1 as one").get()).toEqual({ one: 1 });
  expect(match<"a" | "b">("a").with("a", () => 1).with("b", () => 2).exhaustive()).toBe(1);
  expect(z.string().parse("x")).toBe("x");
});
```

Add `globals: true` to the Vitest config, or import `test`/`expect` from `vitest` (match the root tests, which import them).

- [ ] **Step 4: Run it**

Run: `cd updater && bun run test && bun run typecheck`
Expected: 1 test passes, typecheck clean. If `bun --bun vitest` cannot run at all, stop and report (the spec depends on it).

- [ ] **Step 5: Root adjustments**

- `package.json`: `"zod": "4.6.7"` (exact), `npm install`.
- `tsconfig.json`: `"exclude": ["node_modules", "updater"]`.
- `vitest.config.ts`: add `"shared/**/*.test.ts"` to `include`.
- `.gitignore`: `/updater/node_modules/`, `/updater/data/`.
- `.oxfmtrc.json`: ignore `updater/bun.lock`.
- `.dockerignore`: add `updater` (the portal image does not need it).

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all pass (oxlint and oxfmt now also cover `updater/`; run `npm run format` if needed).

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm updater/src/smoke.test.ts
git add updater package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .oxfmtrc.json .dockerignore
git commit -m "build: scaffold the updater (Bun, NestJS, Vitest)"
```

---

### Task 2: Shared API schemas

**Files:**
- Create: `shared/updater-api.ts`, `shared/updater-api.test.ts`

**Interfaces:**
- Produces (all exported as zod schema `xSchema` + type `X = z.infer<…>`):
  - `UpdateMode = "pull" | "version" | "recipe"`
  - `ServiceKind = "floating" | "variable" | "literal" | "pinned"`
  - `ServiceStatus = { name: string; image: string; kind: ServiceKind; current: string | null; available: string | null; newImageDate: string | null /* ISO */; update: boolean; error: string | null }`
  - `StackStatus = { name: string; mode: UpdateMode; confirm: boolean; last: boolean; recipe: "authentik" | null; services: ServiceStatus[]; update: boolean; button: boolean; current: string | null; available: string | null; major: boolean; needsConfirm: boolean; rollback: { to: string } | null; error: string | null; checkedAt: string | null }`
  - `StacksResponse = { stacks: StackStatus[]; lastCheck: string | null; configError: string | null; runningJob: number | null }`
  - `JobKind = "check" | "update" | "rollback" | "update-all"`; `JobStatus = "running" | "success" | "failed" | "interrupted"`
  - `JobStep = { stack: string; status: "pending" | "running" | "success" | "failed" | "not-started"; from: string | null; to: string | null }`
  - `Job = { id: number; kind: JobKind; user: string | null; startedAt: string; endedAt: string | null; status: JobStatus; steps: JobStep[] }`
  - `JobEvent = { type: "log"; line: string } | { type: "step"; step: JobStep } | { type: "end"; status: JobStatus }` (discriminated on `type`)
  - `HistoryPage = { jobs: Job[]; nextCursor: number | null }`
  - `UpdateBody = { confirm?: true }`
  - `StartResponse = { jobId: number }`
  - `NeedsConfirmResponse = { needsConfirm: { from: string | null; to: string | null; diff: string | null; warning: string | null } }`
  - `UpdateResponse = StartResponse | NeedsConfirmResponse`
  - `ErrorResponse = { error: string }`

- [ ] **Step 1: Write the failing tests**

```ts
test("JobEvent is discriminated on type", () => {
  expect(jobEventSchema.parse({ type: "end", status: "failed" })).toEqual({ type: "end", status: "failed" });
  expect(() => jobEventSchema.parse({ type: "end", status: "nope" })).toThrow();
});
test("UpdateResponse accepts both shapes", () => {
  expect(updateResponseSchema.parse({ jobId: 3 })).toEqual({ jobId: 3 });
  const preview = { needsConfirm: { from: "2026.8.3", to: "2026.10.1", diff: "--- a", warning: null } };
  expect(updateResponseSchema.parse(preview)).toEqual(preview);
});
test("StackStatus rejects an unknown mode", () => {
  expect(() => stackStatusSchema.parse({ ...validStack, mode: "magic" })).toThrow();
});
```

(`validStack`: a full literal `StackStatus` in the test file.)

- [ ] **Step 2: Run, expect failure** — `npx vitest run shared` → FAIL, module not found.
- [ ] **Step 3: Implement the schemas** in `shared/updater-api.ts` (zod only).
- [ ] **Step 4: Run, expect pass** — `npx vitest run shared` and `cd updater && bun run typecheck`.
- [ ] **Step 5: Commit** — `git add shared && git commit -m "feat(updater): shared API schemas"`

---

### Task 3: Config and stack discovery

**Files:**
- Create: `updater/src/config.ts`, `updater/src/config.test.ts`, `updater/src/discovery.ts`, `updater/src/discovery.test.ts`, `updater/src/test/fakes.ts` (temp-dir helper only for now), `deploy/updater-config.example.yml`

**Interfaces:**
- Produces:
  - `type StackConfig = { version?: { file: string; variable: string }; recipe?: "authentik"; confirm: boolean; last: boolean; before: string[]; beforeOnlyOnMajor: boolean }`
  - `type UpdaterConfig = { exclude: string[]; stacks: Record<string, StackConfig> }`
  - `parseConfig(text: string): UpdaterConfig` (throws ZodError / YAML error)
  - `stackConfig(config: UpdaterConfig, name: string): StackConfig` (defaults when absent)
  - `createConfigLoader(path: string): () => Promise<{ config: UpdaterConfig; error: string | null }>`
  - `type DiscoveredStack = { name: string; dir: string; composeFile: string }`
  - `discoverStacks(root: string, exclude: string[]): Promise<DiscoveredStack[]>` (sorted by name)
  - `tempDir(): Promise<string>` in `test/fakes.ts`

- [ ] **Step 1: Write the failing tests**

config.test.ts:
- `parseConfig` of the spec's example YAML (copy it into the test) returns `stacks.mealie.version = { file: ".env", variable: "VERSION" }`, `stacks.frigate.confirm = true`, `stacks.traefik.last = true`.
- empty text and `{}` → `{ exclude: [], stacks: {} }`.
- unknown key (`stacks: { x: { confrm: true } }`) throws.
- `recipe` without `version` throws.
- `variable: "1BAD"` throws (must match `/^[A-Za-z_][A-Za-z0-9_]*$/`).
- `stackConfig(config, "unknown")` → `{ confirm: false, last: false, before: [], beforeOnlyOnMajor: false }`.
- loader: missing file → `{ config: { exclude: [], stacks: {} }, error: null }`; valid then invalid file → previous config and `error` containing the zod message; then valid again → `error: null`.

discovery.test.ts (build a temp root):
- dirs `a/compose.yml`, `b/docker-compose.yaml`, `c/` (no compose file), `x.back/compose.yml`, `y.bak-2026/compose.yml`, `updater/compose.yml`, plain file `notes.txt` → `discoverStacks(root, ["*.back", "*.bak-*"])` returns `a`, `b` only, with `composeFile` names.
- a dir with both `compose.yml` and `docker-compose.yml` → `composeFile: "compose.yml"` (order from Global Constraints).
- `exclude: ["a"]` removes `a`.

- [ ] **Step 2: Run, expect failure** — `bun run test src/config src/discovery`.
- [ ] **Step 3: Implement.** Glob matching: only `*` is special (escape the rest, `*` → `.*`, anchored). Loader re-reads the file on every call (no cache by mtime: the spec says re-read on every check).
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Write `deploy/updater-config.example.yml`** — the spec's example, commented.
- [ ] **Step 6: Commit** — `feat(updater): config file and stack discovery`

---

### Task 4: Image references and version maths

**Files:**
- Create: `updater/src/image-ref.ts`, `updater/src/image-ref.test.ts`, `updater/src/versions.ts`, `updater/src/versions.test.ts`

**Interfaces:**
- Produces:
  - `type ImageRef = { registry: string; repository: string; tag: string; digest: string | null }`
  - `parseImageRef(ref: string): ImageRef`
  - `type TagShape = { prefix: string; numbers: number[]; suffix: string }`
  - `parseTag(tag: string): TagShape | null` — regex `/^(\D*?)(\d+(?:\.\d+)*)(\D.*)?$/`; `null` when no number.
  - `newestAbove(current: string, tags: string[]): string | null` — same prefix, same number count, same suffix; numerically highest above `current`.
  - `compareVersions(a: string, b: string): number` (same shape assumed)
  - `isMajorBump(from: string, to: string): boolean` — first numeric segment increases, except when the first segment is ≥ 2000 (date style) → `false`.
  - `isLiteralVersion(tag: string): boolean` — `/^v?\d+\.\d+\.\d+/`
  - `authentikTarget(current: string, tags: string[]): { kind: "patch" | "minor"; to: string } | null`

- [ ] **Step 1: Write the failing tests**

image-ref:
```ts
expect(parseImageRef("nginx")).toEqual({ registry: "registry-1.docker.io", repository: "library/nginx", tag: "latest", digest: null });
expect(parseImageRef("docker.io/jc21/x:2")).toMatchObject({ registry: "registry-1.docker.io", repository: "jc21/x", tag: "2" });
expect(parseImageRef("lscr.io/linuxserver/sonarr:latest")).toMatchObject({ registry: "lscr.io", repository: "linuxserver/sonarr" });
expect(parseImageRef("ghcr.io/goauthentik/server:2026.8.3")).toMatchObject({ registry: "ghcr.io", tag: "2026.8.3" });
expect(parseImageRef("registry:5000/team/app")).toMatchObject({ registry: "registry:5000", repository: "team/app", tag: "latest" });
expect(parseImageRef("nginx:1.31.6-alpine@sha256:abc")).toMatchObject({ tag: "1.31.6-alpine", digest: "sha256:abc" });
```

versions:
```ts
expect(newestAbove("1.31.6-alpine", ["1.31.7-alpine", "1.32.0", "1.32.0-alpine", "1.31.10-alpine", "mainline-alpine"])).toBe("1.32.0-alpine");
expect(newestAbove("v3.4.0", ["v3.5.0", "3.6.0", "v3.10.0", "v3.10"])).toBe("v3.10.0");
expect(newestAbove("v3.4.0", ["v3.3.0"])).toBeNull();
expect(isMajorBump("v3.4.0", "v4.0.0")).toBe(true);
expect(isMajorBump("2026.8.3", "2027.1.0")).toBe(false);
expect(isLiteralVersion("v3.7")).toBe(false);
expect(isLiteralVersion("1.31.6-alpine")).toBe(true);
const tags = ["2026.8.3", "2026.8.4", "2026.10.0", "2026.10.2", "2026.12.1", "2026.10.2-rc1", "latest"];
expect(authentikTarget("2026.8.3", tags)).toEqual({ kind: "patch", to: "2026.8.4" });
expect(authentikTarget("2026.8.4", tags)).toEqual({ kind: "minor", to: "2026.10.2" }); // 2026.9 absent, skip to next published minor
expect(authentikTarget("2026.12.1", tags)).toBeNull();
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Docker Hub rules: no registry host (first segment has no `.` or `:` and is not `localhost`) → `registry-1.docker.io`; `docker.io` / `index.docker.io` → `registry-1.docker.io`; single-segment repo → `library/` prefix. Authentik tags: only `/^\d{4}\.\d+\.\d+$/`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): image references and version comparison`

---

### Task 5: `.env` variable read / rewrite

**Files:**
- Create: `updater/src/env-file.ts`, `updater/src/env-file.test.ts`

**Interfaces:**
- Produces:
  - `readVariable(text: string, name: string): string | null` (value of the last definition, quotes removed)
  - `rewriteVariable(text: string, name: string, value: string): string` — throws `Error("variable <name> absente de <file>")`-style message when absent (the caller passes the file name in the message).
  - `readVariableFile(path: string, name: string): Promise<string | null>`, `writeVariableFile(path: string, name: string, value: string): Promise<void>` (write to `path + ".updater-tmp"` then rename)

- [ ] **Step 1: Write the failing tests** (Review Focus 1)

```ts
const env = 'A=1\r\nexport VERSION="v3.4.0" # pinned\r\nB=2';
expect(readVariable(env, "VERSION")).toBe("v3.4.0");
expect(rewriteVariable(env, "VERSION", "v3.5.0")).toBe('A=1\r\nexport VERSION="v3.5.0" # pinned\r\nB=2');
expect(rewriteVariable("V='1'\n", "V", "2")).toBe("V='2'\n");
expect(rewriteVariable("V=1\nV=2\n", "V", "3")).toBe("V=1\nV=3\n");
expect(rewriteVariable("VERSIONX=1\n#VERSION=0\nVERSION = 1", "VERSION", "2")).toBe("VERSIONX=1\n#VERSION=0\nVERSION = 2");
expect(() => rewriteVariable("A=1\n", "VERSION", "2")).toThrow(/VERSION/);
expect(readVariable("A=1", "VERSION")).toBeNull();
```

And a file test: `writeVariableFile` on a temp file keeps every other byte (compare with `rewriteVariable` output) and leaves no `.updater-tmp` behind.

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** with a line regex `^(\s*(?:export\s+)?NAME\s*=\s*)(["']?)([^"'#\r\n]*?)\2(\s*(?:#.*)?)$` per line, splitting on `\n` and keeping `\r`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): rewrite a single .env variable`

---

### Task 6: Registry client

**Files:**
- Create: `updater/src/registry.ts`, `updater/src/registry.test.ts`

**Interfaces:**
- Consumes: `ImageRef` (Task 4)
- Produces:
  - `interface Registry { digest(ref: ImageRef): Promise<string>; details(ref: ImageRef): Promise<{ version: string | null; created: string | null }>; tags(ref: ImageRef): Promise<string[]> }`
  - `createHttpRegistry(options: { fetch?: typeof fetch; timeoutMs?: number /* default 15000 */ }): Registry`

- [ ] **Step 1: Write the failing tests** with a fake `fetch` (a function routing on URL + method, recording calls):
- `digest`: first `HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest` → `401` with `WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"`; client GETs the realm with `service` and `scope` query params, then retries HEAD with `Authorization: Bearer <token>`; returns the `Docker-Content-Digest` header. The `Accept` header includes `application/vnd.oci.image.index.v1+json`, `application/vnd.docker.distribution.manifest.list.v2+json`, `application/vnd.oci.image.manifest.v1+json`, `application/vnd.docker.distribution.manifest.v2+json`. The token is reused for a second call on the same repository (one token request in total).
- `tags`: follows `Link: </v2/library/nginx/tags/list?n=1000&last=b>; rel="next"` until absent, returns all tags concatenated.
- `details`: index → picks the `linux/amd64` manifest → config blob → returns `config.Labels["org.opencontainers.image.version"]` and `created`; single-arch manifest goes straight to config; missing label → `version: null`.
- non-2xx (e.g. `429`) → throws an `Error` whose message contains the status and the image.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Token cache keyed by `registry + repository`. Timeout via `AbortSignal.timeout`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): registry HTTP API client`

---

### Task 7: SQLite store

**Files:**
- Create: `updater/src/store.ts`, `updater/src/store.test.ts`

**Interfaces:**
- Consumes: `StackStatus`, `Job`, `JobStep`, `JobKind`, `JobStatus`, `HistoryPage` (Task 2)
- Produces:
  - `type RollbackState = { stack: string; to: string; data: { kind: "pull"; services: { service: string; image: string }[] } | { kind: "version"; file: string; variable: string; value: string } | { kind: "recipe"; file: string; variable: string; value: string; compose: string } }`
  - `class Store` with `constructor(db: Database)` (creates tables) and:
    `getMeta(key: string): string | null`, `setMeta(key: string, value: string | null): void`,
    `stackStatuses(): StackStatus[]`, `saveStackStatuses(list: StackStatus[]): void` (replaces all), `saveStackStatus(status: StackStatus): void`,
    `createJob(input: { kind: JobKind; user: string | null; steps: JobStep[]; startedAt: string }): Job`, `appendLog(id: number, line: string): void`, `setSteps(id: number, steps: JobStep[]): void`, `finishJob(id: number, status: JobStatus, endedAt: string): void`, `job(id: number): Job | null`, `jobLog(id: number): string[]`, `history(cursor: number | null, limit?: number /* 20 */): HistoryPage`, `markInterrupted(endedAt: string): number`,
    `saveRollback(state: RollbackState): void`, `rollback(stack: string): RollbackState | null`, `deleteRollback(stack: string): void`,
    `purgeLogs(endedBefore: string): number`

- [ ] **Step 1: Write the failing tests** (`new Database(":memory:")`):
- create → appendLog ×3 → `jobLog` returns the 3 lines in order; `finishJob` sets `status` and `endedAt`.
- `history(null, 2)` on 3 jobs → newest 2 and `nextCursor` = id of the 2nd; `history(nextCursor, 2)` → the oldest and `nextCursor: null`.
- `markInterrupted` turns `running` jobs into `interrupted` and returns their count; finished jobs untouched.
- `purgeLogs` deletes log lines of jobs ended before the cutoff only; the job rows remain.
- rollback save / read / delete round-trip; `saveStackStatuses` replaces the whole list.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Tables: `meta(key primary key, value)`, `stacks(name primary key, json)`, `jobs(id integer primary key autoincrement, kind, user, started_at, ended_at, status, steps_json)`, `job_logs(job_id, seq, line)`, `rollbacks(stack primary key, json)`. Enable WAL.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): SQLite store`

---

### Task 8: Docker interface and detection

**Files:**
- Create: `updater/src/docker.ts`, `updater/src/detection.ts`, `updater/src/detection.test.ts`
- Modify: `updater/src/test/fakes.ts` (add `FakeDocker`, `FakeRegistry`)

**Interfaces:**
- Consumes: Tasks 3–7
- Produces:
  - in `docker.ts`:
    ```ts
    type ComposeService = { name: string; image: string /* resolved */; rawImage: string /* --no-interpolate */ };
    type ContainerState = { service: string; state: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead"; exitCode: number; health: "starting" | "healthy" | "unhealthy" | null; imageId: string };
    type LocalImage = { id: string; repoDigests: string[]; version: string | null; created: string | null };
    type LogSink = (line: string) => void;
    interface Docker {
      composeServices(dir: string): Promise<ComposeService[]>;
      containers(project: string): Promise<ContainerState[]>;
      image(ref: string): Promise<LocalImage | null>;
      compose(dir: string, args: string[], log: LogSink): Promise<number>;
      shell(dir: string, command: string, log: LogSink): Promise<number>;
      tag(source: string, target: string): Promise<void>;
      removeImage(ref: string): Promise<void>;
    }
    ```
  - `FakeDocker implements Docker` (in-memory maps, records `compose`/`shell`/`tag` calls, scriptable exit codes and container states per call), `FakeRegistry implements Registry` (maps keyed by `repository:tag`, scriptable errors).
  - in `detection.ts`: `type DetectionDeps = { docker: Docker; registry: Registry; now: () => Date }`, `checkStack(stack: DiscoveredStack, config: StackConfig, rollback: RollbackState | null, deps: DetectionDeps): Promise<StackStatus>`, `checkAll(input: { root: string; config: UpdaterConfig; store: Store }, deps: DetectionDeps, log: LogSink): Promise<StackStatus[]>` (saves statuses and `meta.lastCheck`).

- [ ] **Step 1: Write the failing tests** (FakeDocker + FakeRegistry + temp stack dirs)
- floating: local `repoDigests` contains `lscr.io/linuxserver/x@sha256:old`, remote digest `sha256:new` → service `update: true`, `kind: "floating"`; with local version label `1.0` and remote `1.1` → `current: "1.0"`, `available: "1.1"`; without labels → `newImageDate` = remote `created`.
- same digest → `update: false`, and `registry.details` not called.
- variable (mealie): `.env` `VERSION=v3.4.0`, rawImage `ghcr.io/mealie-recipes/mealie:${VERSION}`, tags include `v3.5.0` → `mode: "version"`, stack `current: "v3.4.0"`, `available: "v3.5.0"`, `button: true`, `needsConfirm: false`.
- major: tags include `v4.0.0` → `major: true`, `needsConfirm: true`.
- literal (group-gate): rawImage `nginx:1.31.6-alpine`, tag `1.31.7-alpine` exists → `kind: "literal"`, `update: true`, `button: false`.
- pinned: `x@sha256:abc` → `kind: "pinned"`, `update: false`, no registry call. (Review Focus 4)
- authentik recipe: `AUTHENTIK_TAG=2026.8.4`, tags as in Task 4 → `mode: "recipe"`, `available: "2026.10.2"`, `needsConfirm: true`; with `2026.8.3` → `available: "2026.8.4"`, `needsConfirm: false`.
- `confirm: true` in config → `needsConfirm: true` whatever the bump.
- registry `429` on one service of a two-service stack → that service `error` set, the other checked; `checkAll` over two stacks still returns both. (Review Focus 2)
- `composeServices` throwing → stack `error` = message, `button: false`, `update: false`. (Review Focus 3)
- rollback state present → `rollback: { to }`.
- `checkAll` writes `meta.lastCheck` = `now().toISOString()` and every status has `checkedAt`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Mode: `recipe` if `config.recipe`, else `version` if `config.version`, else `pull`. Kind per Decision 3; use `match` on kind for the per-service check. Stack `update` = any service `update`; `button` per Decision 4 and `error === null`; stack `current`/`available` = the variable's values in version/recipe mode, else those of the first updated service that has both. `major` = `isMajorBump(current, available)` when both known.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): update detection`

---

### Task 9: Job runner

**Files:**
- Create: `updater/src/jobs.ts`, `updater/src/jobs.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 7), `JobEvent`, `JobStep`, `JobKind`, `JobStatus` (Task 2)
- Produces:
  - `class BusyError extends Error`
  - `type JobContext = { id: number; log: LogSink; setSteps(steps: JobStep[]): void }`
  - `class JobRunner` with `constructor(store: Store, now: () => Date)` and
    `start(input: { kind: JobKind; user: string | null; steps: JobStep[] }, work: (ctx: JobContext) => Promise<"success" | "failed">): Job` (throws `BusyError` if a job runs; work runs in the background),
    `running(): number | null`,
    `events(id: number): AsyncIterable<JobEvent> | null` (`null` for an unknown id; replays stored log + current steps, then follows live events until `end`),
    `idle(): Promise<void>` (resolves when no job runs; for tests and the scheduler)

- [ ] **Step 1: Write the failing tests**
- second `start` while the first runs throws `BusyError`; after it ends, `start` works.
- `work` that throws → job `failed`, the error message is the last log line.
- `events` on a running job: collect while the job logs `a`, `b`, then ends → `[{log a}, {log b}, {end success}]` exactly once each, even when `events` is called after `a` was logged (replay then follow, no duplicates).
- `events` on a finished job → replay then `end`, iterator completes. (Review Focus 5)
- `events(999)` → `null`.
- every `log` line is persisted (`store.jobLog`).
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** with an in-memory listener set per running job; replay reads `store.jobLog` and `store.job` synchronously before registering the listener (both in the same tick, so no line is lost or doubled).
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): job runner with replayable events`

---

### Task 10: Health evaluation

**Files:**
- Create: `updater/src/health.ts`, `updater/src/health.test.ts`

**Interfaces:**
- Consumes: `ContainerState` (Task 8)
- Produces:
  - `evaluateHealth(before: ContainerState[], after: ContainerState[]): { ok: true } | { ok: false; problems: string[] }`
  - `waitHealthy(read: () => Promise<ContainerState[]>, before: ContainerState[], options?: { timeoutMs?: number /* 60000 */; intervalMs?: number /* 2000 */; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<{ ok: true } | { ok: false; problems: string[] }>`

- [ ] **Step 1: Write the failing tests**
- service running before, running + no healthcheck after → ok; `health: "healthy"` → ok.
- `restarting`, `exited` code 1, `unhealthy`, or `running` + `starting` → problem naming the service.
- `exited` code 0 after (one-shot) → ok.
- service not running before (exited/created) → ignored whatever its state after.
- service running before and absent after → problem.
- `waitHealthy` with a fake clock: unhealthy on reads 1–2, healthy on read 3 → ok after 3 reads; always `starting` → not ok once 60 000 ms passed, with ~30 reads.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** (`match` on `state`).
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): post-update health check`

---

### Task 11: Update and rollback of one stack (pull and version modes)

**Files:**
- Create: `updater/src/update.ts`, `updater/src/update.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 7, 8, 10
- Produces:
  - `type StackContext = { stack: DiscoveredStack; config: StackConfig; status: StackStatus; docker: Docker; store: Store; log: LogSink; wait?: typeof waitHealthy }`
  - `updateStack(ctx: StackContext): Promise<"success" | "failed">` — pull and version modes, and Authentik patch updates (a recipe stack whose `needsConfirm` is false).
  - `rollbackStack(ctx: StackContext): Promise<"success" | "failed">` — all three rollback kinds.
  - `rollbackTag(project: string, service: string): string` → `updater-rollback/<project>-<service>:latest`

- [ ] **Step 1: Write the failing tests** (FakeDocker, temp stack dir, `wait` stubbed to ok unless stated)
- pull: before containers `[{service: "app", state: "running", imageId: "sha256:old"}]` → calls in order: `tag("sha256:old", "updater-rollback/stirling-app:latest")`, `compose(["pull"])`, `compose(["up", "-d"])`; rollback saved `{ kind: "pull", services: [{ service: "app", image: "<resolved ref>" }] }`; result `success`.
- pull: previous rollback state had service `old` no longer in the stack → `removeImage("updater-rollback/stirling-old:latest")`.
- version: `.env` `VERSION=v3.4.0`, `available: "v3.5.0"` → `.env` now `VERSION=v3.5.0`, rollback `{ kind: "version", value: "v3.4.0" }`, then pull + up.
- version with the variable missing from `.env` → `failed`, `.env` unchanged, no compose call. (Review Focus 1)
- `before: ["false"]` → `shell` exit 1 → `failed`, no compose call, `.env` unchanged; `before` runs with `cwd` = stack dir.
- `beforeOnlyOnMajor: true`: skipped when `major: false` and both versions known; run when `major: true`; run when `current` or `available` is `null`.
- `compose pull` exit 1 → `failed`, log contains compose output, and for version mode the `.env` was already rewritten (rollback state saved before, so rollback can restore it).
- `composeServices` throwing at update time → `failed`, nothing rewritten. (Review Focus 3)
- health not ok → `failed`, log lists the problems.
- rollback pull: `tag("updater-rollback/stirling-app:latest", "<resolved ref>")`, `compose(["up", "-d"])`; on success rollback state deleted and the rollback tag removed.
- rollback version: `.env` back to `v3.4.0`, `compose(["up", "-d", "--pull", "missing"])`.
- rollback recipe: `compose.yml` content and variable restored, same compose call.
- rollback with no saved state → `failed` with a log line.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** `RollbackState.to` = `status.current` when known, else « l'image précédente ». Order for an update: read `before` containers and compose services → save rollback state (pull: tag images first) → `before` commands → rewrite variable (version mode) → `pull` → `up -d` → `waitHealthy`. Every compose and shell line goes to `log`; prefix each step with a log line (`== docker compose pull`). `match` on `status.mode` / `state.data.kind`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): update and roll back a stack`

---

### Task 12: Authentik recipe

**Files:**
- Create: `updater/src/authentik.ts`, `updater/src/authentik.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 7, 8, 10, 11 (`StackContext`)
- Produces:
  - `upstreamComposeUrl(minor: string): string`
  - `normalizeCompose(text: string): string` — removes `\r`, replaces `${AUTHENTIK_TAG:-<anything>}` with `${AUTHENTIK_TAG}`
  - `authentikPreview(ctx: StackContext, fetchFn?: typeof fetch): Promise<{ ok: true; from: string; to: string; diff: string } | { ok: false; error: string }>` — the error is exactly « Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml » when the local file differs.
  - `authentikMinorUpdate(ctx: StackContext, fetchFn?: typeof fetch): Promise<"success" | "failed">`

- [ ] **Step 1: Write the failing tests** (fake fetch serving `2026.8` and `2026.10` upstream files; stack dir with `compose.yml` = 2026.8 upstream but CRLF and `${AUTHENTIK_TAG:-2026.8.1}` where upstream has `:-2026.8.4`, `.env` `AUTHENTIK_TAG=2026.8.4`, status `available: "2026.10.2"`)
- `upstreamComposeUrl("2026.10")` → `https://goauthentik.io/version/2026.10/lifecycle/container/compose.yml`.
- preview → `ok`, `from: "2026.8.4"`, `to: "2026.10.2"`, `diff` is a unified diff 2026.8 upstream → 2026.10 upstream (contains `---`, `+++`).
- local file with an extra line → `{ ok: false, error: <exact text> }` and no file changed.
- minor update → `compose.yml` = 2026.10 upstream byte for byte, `.env` `AUTHENTIK_TAG=2026.10.2`, rollback `{ kind: "recipe", compose: <old file>, value: "2026.8.4" }`, then pull + up; no `compose.override.yml` created (with and without one present beforehand).
- upstream fetch `404` → `failed`, nothing changed.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** with `createTwoFilesPatch` from `diff`. Minor update re-runs the local-modifications check before writing.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): Authentik minor-upgrade recipe`

---

### Task 13: « Tout mettre à jour » sequencing

**Files:**
- Create: `updater/src/update-all.ts`, `updater/src/update-all.test.ts`

**Interfaces:**
- Consumes: `StackStatus`, `JobStep`
- Produces:
  - `planUpdateAll(stacks: StackStatus[]): string[]` — eligible: `update && button && !needsConfirm && error === null`; non-`last`/non-`recipe` first, then `last` or `recipe` ones; each group sorted by name.
  - `runUpdateAll(queue: string[], run: (stack: string, log: LogSink) => Promise<"success" | "failed">, ctx: JobContext, steps: JobStep[]): Promise<"success" | "failed">` — sets each step `running` → `success`/`failed`; after a failure the remaining steps become `not-started` (rendered « non lancées »).

- [ ] **Step 1: Write the failing tests**
- input: `traefik` (last), `stirling`, `frigate` (confirm), `authentik` (recipe, patch, no confirm), `mealie` (major), `group-gate` (no button), `cloudflared` (last), `downloads` → `["downloads", "stirling", "authentik", "cloudflared", "traefik"]`.
- run with the 2nd failing → steps `[success, failed, not-started, not-started, not-started]`, `run` called twice, result `failed`.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** with remeda `filter`/`partition`/`sortBy`.
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit** — `feat(updater): ordered update-all with stop on failure`

---

### Task 14: UpdaterService, HTTP API, scheduler, Docker CLI, entry point

**Files:**
- Create: `updater/src/service.ts`, `updater/src/service.test.ts`, `updater/src/http/tokens.ts`, `updater/src/http/auth.guard.ts`, `updater/src/http/controllers.ts`, `updater/src/http/app.module.ts`, `updater/src/http/http.test.ts`, `updater/src/scheduler.ts`, `updater/src/docker-cli.ts`, `updater/src/main.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `class UpdaterService` with `constructor(deps: { root: string; loadConfig: () => Promise<{ config: UpdaterConfig; error: string | null }>; docker: Docker; registry: Registry; store: Store; jobs: JobRunner; now: () => Date; fetch?: typeof fetch })` and:
    `stacks(): StacksResponse`, `check(user: string | null): Job`, `update(name: string, body: UpdateBody, user: string | null): Promise<UpdateResponse>`, `rollback(name: string, user: string | null): Job`, `updateAll(user: string | null): Job`, `job(id: number): Job | null`, `events(id: number): AsyncIterable<JobEvent> | null`, `history(cursor: number | null): HistoryPage`.
    Errors: throws `NotFoundError`, `BadRequestError`, `BusyError` (mapped to 404 / 400 / 409 by the controller).
  - tokens: `UPDATER_SERVICE`, `UPDATER_TOKEN`.
  - `createApp(service: UpdaterService, token: string): Promise<INestApplication>`
  - `startScheduler(service: UpdaterService, jobs: JobRunner, store: Store, now: () => Date): () => void` (returns stop)
  - `createDockerCli(): Docker`

- [ ] **Step 1: Write the failing service tests** (fakes, temp root)
- `update` on a `needsConfirm` stack without `confirm` → `{ needsConfirm: {...} }` and no job started; with `{ confirm: true }` → `{ jobId }`. Authentik minor without confirm → `needsConfirm.diff` set; local modifications → `BadRequestError` with the exact French message.
- `update` on `button: false` → `BadRequestError`; unknown stack → `NotFoundError`; while a job runs → `BusyError`.
- a successful update job re-checks the stack: `stacks()` then shows `update: false` for it, and `rollback.to` = previous version (or « l'image précédente » for pull mode without version).
- `job.steps[0]` carries `from`/`to` of the update.
- `check` uses the config error: invalid `config.yml` → `stacks().configError` set and previous config used.
- [ ] **Step 2: Write the failing HTTP tests** (`createApp` with a stub service, `app.listen(0)`, real `fetch`)
- `GET /health` without token → 200; `GET /stacks` without or with a wrong token → 401; with token → 200 body parsed by `stacksResponseSchema`.
- `POST /stacks/x/update` stub throwing `BusyError` → 409 `{ error }`; `NotFoundError` → 404.
- `POST` passes `X-Updater-User` to the service.
- `POST /stacks/x/update` with body `{ "confirm": "yes" }` → 400 (validated with `updateBodySchema`).
- `GET /jobs/1/events` → `content-type: text/event-stream`, each event `data: <JobEvent JSON>`, stream closes after `end`; unknown id → 404.
- `GET /history?cursor=5` passes `5`; no cursor → `null`.
- [ ] **Step 3: Run, expect failure.**
- [ ] **Step 4: Implement**
  - Service: `check`/`update`/`rollback`/`updateAll` start jobs through `JobRunner`; `update` dispatches with `match(status.mode)`: pull/version → `updateStack`; recipe → `authentikMinorUpdate` when it is a minor change, else `updateStack`.
  - Guard: constant-time compare (`crypto.timingSafeEqual` on equal-length buffers); `/health` bypass.
  - Controllers: routes exactly as the spec's API block; SSE with `@Sse()` returning `from(asyncIterable).pipe(map((e) => ({ data: e })))`, or a raw `@Res()` stream if Nest 12's `@Sse` cannot end the stream: choose one and keep the HTTP test green.
  - Scheduler: on start, run a check if `meta.lastCheck` is absent or older than 6 h; then every 6 h, skip when a job runs; once a day `store.purgeLogs(now - 90 days)`.
  - `docker-cli.ts`: `Bun.spawn` with `cwd`, merge stdout+stderr line by line into `log` (stderr warnings are logged, never failures); `composeServices` = `docker compose config --format json` and `docker compose config --no-interpolate --format json` in the stack dir; `containers` = `docker compose -p <project> ps -a --format json` (one JSON object per line) + `docker inspect` for `imageId`; `image` = `docker image inspect` (version from `Config.Labels["org.opencontainers.image.version"]`, `Created`), `null` when absent.
  - `main.ts`: `import "reflect-metadata"`, read env (Global Constraints; exit with a clear message if `UPDATER_TOKEN` is unset), open `${UPDATER_DATA}/updater.db`, `store.markInterrupted(now)`, build everything, `createApp(...).listen(PORT, "0.0.0.0")`, `startScheduler`.
- [ ] **Step 5: Run, expect pass** — `bun run test && bun run typecheck`
- [ ] **Step 6: Local smoke run against the local Docker** (optional but recommended): `UPDATER_TOKEN=t UPDATER_ROOT=$(mktemp -d) UPDATER_DATA=$(mktemp -d) bun src/main.ts`, then `curl -H 'Authorization: Bearer t' localhost:8080/stacks` → `{"stacks":[],...}`.
- [ ] **Step 7: Commit** — `feat(updater): HTTP API, scheduler and Docker CLI adapter`

---

### Task 15: Updater image, deployment files, CI, README

**Files:**
- Create: `updater/Dockerfile`, `updater/Dockerfile.dockerignore`, `deploy/updater-compose.yml`
- Modify: `deploy/compose.yml`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: image `ghcr.io/rykian/portail-updater`; external network `updater`; portal env `UPDATER_URL`, `UPDATER_TOKEN`.

- [ ] **Step 1: Dockerfile** (build context = repo root)

```dockerfile
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
```

Runs as root (it needs `/root` and `docker.sock`). Check the `docker:29-cli` paths with `docker run --rm docker:29-cli ls /usr/local/libexec/docker/cli-plugins` and the image has `sh`, `tar`, `gzip` (`docker run --rm <img> sh -c 'tar --version && gzip --version && docker compose version'`). `Dockerfile.dockerignore`: ignore everything except `updater/package.json`, `updater/bun.lock`, `updater/tsconfig.json`, `updater/src`, `shared`; exclude `**/*.test.ts` and `updater/src/test`.

- [ ] **Step 2: Build and run the image**

Run: `docker build -f updater/Dockerfile -t updater-test . && docker run --rm -e UPDATER_TOKEN=t -p 8080:8080 updater-test` then `curl localhost:8080/health`
Expected: 200.

- [ ] **Step 3: `deploy/updater-compose.yml`**

```yaml
# Copy to /root/updater/compose.yml on CT 100, next to .env (UPDATER_TOKEN), config.yml and data/.
services:
  updater:
    image: ghcr.io/rykian/portail-updater:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root:/root            # same path: compose resolves bind mounts on the client side
      - ./data:/data
    networks: [updater]

networks:
  updater:
    name: updater            # normal bridge: needs outbound internet for registries
```

`deploy/compose.yml` (portal): `networks: [proxy, updater]`, `updater: { external: true }`, environment `UPDATER_URL: http://updater:8080`; `UPDATER_TOKEN` goes in the portal's `.env`.

- [ ] **Step 4: CI** — in `.github/workflows/ci.yml` add:
  - job `updater`: checkout, `oven-sh/setup-bun@v2` with `bun-version: 1.4.4`, `working-directory: updater`: `bun ci`, `bun run typecheck`, `bun run test`.
  - job `image-updater`: on push to main, `needs: updater`, same login/metadata/build-push steps as `image` with `images: ghcr.io/rykian/portail-updater`, `file: updater/Dockerfile`, `context: .`.
  (Lint and format of `updater/` already run in `check` through the root oxlint/oxfmt.)

- [ ] **Step 5: README** — new section « Mises à jour des conteneurs (updater) »: CT 100 deployment (create `/root/updater/` with `compose.yml`, `.env`, `config.yml`, `data/`; start the updater first since it creates the `updater` network; add `UPDATER_TOKEN` to the portal `.env`, `docker compose up -d` the portal), the config reference (the spec's per-stack keys table), `before` commands run inside the updater container (`sh`, `tar`, `gzip`, Docker CLI), and the dev commands (`cd updater && bun install && bun run test`).

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm run format:check` and `cd updater && bun run typecheck && bun run test`
Expected: all pass.

```bash
git add updater/Dockerfile updater/Dockerfile.dockerignore deploy .github/workflows/ci.yml README.md
git commit -m "build: updater image, deployment files and CI"
```

---

### Task 16: Portal client, proxy route, badge and menu entry

**Files:**
- Create: `lib/updater.ts`, `lib/updater.test.ts`, `app/api/updates/[...path]/route.ts`
- Modify: `app/page.tsx`, `components/portal.tsx`, `components/user-menu.tsx`, `e2e/admin.spec.ts`, `e2e/family.spec.ts`, `playwright.config.ts`
- Create: `e2e/fake-updater.ts`

**Interfaces:**
- Consumes: `stacksResponseSchema` etc. from `@/shared/updater-api`
- Produces:
  - `updaterSettings(env: { UPDATER_URL?: string; UPDATER_TOKEN?: string }): { url: string; token: string } | null`
  - `updaterRequest(path: string, init?: { method?: "GET" | "POST"; body?: string; user?: string; signal?: AbortSignal }): Promise<Response>` (throws when not configured)
  - `fetchUpdateCount(options?: { timeoutMs?: number /* 1000 */ }): Promise<number | null>` — `null` on any error, timeout, non-2xx or schema mismatch.
  - `Portal` and `UserMenu` gain prop `updates: number | null`.
  - Fake updater on `http://localhost:3101` (token `e2e-token`), fixture stacks: `stirling` (pull, floating update, `newImageDate`), `mealie` (version `v3.4.0 → v3.5.0`), `group-gate` (literal `1.31.6-alpine → 1.31.7-alpine`, no button), `authentik` (recipe `2026.8.4 → 2026.10.2`, `needsConfirm`), `cloudflared` (up to date). Count = 4. Control route `POST /__down` makes every later request answer 503.

- [ ] **Step 1: Write the failing unit tests** (`lib/updater.test.ts`, `vi.stubGlobal("fetch", …)`)
- `updaterSettings({})` → `null`; with both vars → settings, trailing `/` of the URL removed.
- `fetchUpdateCount` → `2` for a body with two `update: true` stacks; sends `Authorization: Bearer <token>`.
- fetch rejecting, `503`, invalid body, or a fetch that never resolves (fake timers: advance 1 000 ms) → `null`.
- [ ] **Step 2: Run, expect failure** — `npx vitest run lib/updater`
- [ ] **Step 3: Implement `lib/updater.ts`.**
- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Proxy route** `app/api/updates/[...path]/route.ts`, `GET` and `POST`:
  - `getUser()`; no user or `!isAdmin(user.groups)` → `404`.
  - Reject segments that are empty, `.` or `..`; encode each with `encodeURIComponent`; keep the query string.
  - Forward with `updaterRequest` (POST body = `await request.text()`, `user = user.email`, `signal = request.signal`), return `new Response(upstream.body, { status, headers: { "content-type": <upstream>, "cache-control": "no-store" } })`.
  - Updater not configured or unreachable → `502 { error: "Service de mise à jour injoignable" }`.
- [ ] **Step 6: Badge and menu.** `app/page.tsx`: `const updates = admin ? await fetchUpdateCount() : null` (admin only, never throws). `UserMenu`: if `updates` > 0 a red pill with the count on the avatar (`aria-label` « N mises à jour »); for admins an item « Mises à jour » (« Mises à jour (N) » when N > 0) linking `/admin/updates`, placed between « Administration » and the separator before « Se déconnecter ».
- [ ] **Step 7: Fake updater + Playwright config.** `e2e/fake-updater.ts` (Node `http`, runs with `node e2e/fake-updater.ts`; it may import `@/shared/...` only through a relative path). `playwright.config.ts`: `webServer` becomes an array with the fake (`url: http://localhost:3101/health`); the portal server gets `UPDATER_URL=http://localhost:3101`, `UPDATER_TOKEN=e2e-token`.
- [ ] **Step 8: E2E tests**
  - `admin.spec.ts`: avatar shows pill `4`; menu has « Mises à jour (4) » between « Administration » and « Se déconnecter ».
  - `family.spec.ts`: no pill, no « Mises à jour » item; `request.get("/api/updates/stacks")` → 404.
- [ ] **Step 9: Run** — `npm run lint && npm run typecheck && npm test && npm run e2e` → all pass.
- [ ] **Step 10: Commit** — `feat: updates badge, menu entry and updater proxy`

---

### Task 17: Page `/admin/updates`

**Files:**
- Create: `app/admin/updates/page.tsx`, `components/updates/updates-page.tsx`, `components/updates/stacks-table.tsx`, `components/updates/stacks-cards.tsx`, `components/updates/job-panel.tsx`, `components/updates/confirm-dialog.tsx`, `components/updates/history.tsx`, `lib/relative-time.ts`, `lib/relative-time.test.ts`, `e2e/updates.spec.ts`
- Add with shadcn (Base UI): `tabs`, `dialog`, `table` (`npx shadcn@latest add tabs dialog table`; check they import `@base-ui/react`)
- Modify: `e2e/fake-updater.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: proxy route (Task 16) at `/api/updates/*`, shared schemas
- Produces: `relativeTime(from: Date, now: Date): string` (« il y a 2 h », « il y a 5 min », « à l’instant » under 1 min) using `Intl.RelativeTimeFormat("fr", { style: "narrow" })`.

- [ ] **Step 1: Unit test `relativeTime`**: 2 h ago → `"il y a 2 h"`; 30 s ago → `"à l’instant"`; 3 days ago → `"il y a 3 j"`. Run → fail, implement, run → pass. (If `Intl` narrow output differs on Node 24, assert what it returns and keep « Vérifié il y a … ».)
- [ ] **Step 2: Server page** `app/admin/updates/page.tsx`: `getUser()`, non-admin → `notFound()`; renders `<UpdatesPage />` (client). Page title « Mises à jour ».
- [ ] **Step 3: Client page** (`updates-page.tsx`), behaviour:
  - Loads `GET /api/updates/stacks`; error or 502 → « Le service de mise à jour est injoignable. » and nothing else breaks.
  - Tabs « Mises à jour » / « Historique ».
  - Header: « Vérifié il y a … » (from `lastCheck`), « Vérifier maintenant » (`POST checks`), « Tout mettre à jour » (`POST updates`, disabled when `planUpdateAll`-eligible count is 0 — compute client-side: `update && button && !needsConfirm && !error`), view toggle « Tableau » / « Cartes » persisted in `localStorage` key `updates-view` (try/catch, default table).
  - `configError` → a warning banner with the message.
  - Table: stack name; version change (`current → available`, or « nouvelles images » + the updated services' names, or « nouvelle image du <date> » when only `newImageDate`); mode; action. Literal: « nouvelle version disponible : a → b » + hint « Passer la version dans une variable pour l'activer », no button. Error: the error text. Up-to-date stacks collapsed into one line « N à jour » that expands to their names. `rollback` → button « Revenir à <to> ».
  - Cards: same data in a grid like the home page (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`).
  - « Mettre à jour »: `POST stacks/:name/update`; on `needsConfirm` open `confirm-dialog` (from → to, `diff` in a `<pre>`, `warning`), confirm re-POSTs `{ confirm: true }`. `400`/`409` → show the `error` text.
  - Rollback button → confirm dialog → `POST stacks/:name/rollback`.
  - Any `jobId`, or `runningJob` from `/stacks` on load → `job-panel`.
- [ ] **Step 4: Job panel** (`job-panel.tsx`): `EventSource("/api/updates/jobs/<id>/events")`; on every `open` clear the log (server replays from start, Review Focus 5); append `log` lines in a scrolling `<pre>`; show steps with statuses (`not-started` → « non lancées », `interrupted` → « interrompue »); on `end` close the source, refetch `/stacks`, and on `failed` with a stack rollback available show « Revenir à <version> ». EventSource reconnects by itself when the portal restarts.
- [ ] **Step 5: History** (`history.tsx`): `GET history?cursor=`, columns date, user, stack(s), from → to, result; « Plus » loads `nextCursor`; clicking a row opens a dialog with the log, read from `jobs/:id/events` (replay ends with `end`).
- [ ] **Step 6: Fake updater additions**: `POST /stacks/stirling/update` → `{ jobId: 1 }`; `GET /jobs/1/events` → `log "== docker compose pull"`, `log "stirling Pulled"`, `step success`, `end success`; `POST /stacks/authentik/update` without confirm → `needsConfirm` with a diff; history returns the job once started.
- [ ] **Step 7: E2E** `e2e/updates.spec.ts` (admin project; widen its `testMatch` to `/admin|updates/`):
  - page lists the 5 stacks; « 1 à jour » line; group-gate shows « Passer la version dans une variable pour l'activer » and no button.
  - toggle « Cartes », reload → still cards.
  - stirling « Mettre à jour » → log shows « stirling Pulled » once, status success; « Historique » tab lists stirling.
  - authentik « Mettre à jour » → dialog shows the diff; cancel → no job.
  - non-admin: `page.goto("/admin/updates")` → 404 (in `family.spec.ts`).
  - updater down: new project `admin-updater-down` (admin headers, `testMatch: "updater-down.spec.ts"`, `dependencies` on all other projects) whose test first calls `POST http://localhost:3101/__down`, then: home page loads, services shown, no pill; `/admin/updates` says « Le service de mise à jour est injoignable. ».
- [ ] **Step 8: Run** — `npm run lint && npm run format:check && npm run typecheck && npm test && npm run e2e` → all pass.
- [ ] **Step 9: Commit** — `feat: admin page to apply, follow and roll back updates`

---

### Task 18: Acceptance on CT 100 (with the user, manual)

Not for a subagent: needs the user's go-ahead and access to CT 100.

- [ ] Deploy per README; `curl` from the portal container: `docker compose exec portal wget -qO- http://updater:8080/health`.
- [ ] Check the list matches the spec's inventory; authelia, wud, updater, `*.back`, `*.bak-*` absent.
- [ ] Update stirling, watch the log, then « Revenir à … » and confirm the old image runs again.
- [ ] Update Mealie through its variable; `.env` diff shows only `VERSION`.
- [ ] Then remove WUD (spec: after acceptance).
