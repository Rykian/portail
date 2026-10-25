# Updater NestJS Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recut `updater/src/` into real NestJS modules (one folder per domain, Nest-built app, update strategies behind one interface) with zero behaviour change.

**Architecture:** Bottom-up refactor in five green steps: move pure files into module folders, split the `Store`, extract the three update strategies and the shared `StackUpdater`, switch to Nest-built modules with one controller per module, then move start-up/shutdown into Nest lifecycle hooks. Pure functions stay functions; only stateful or dependency-holding classes become providers. Every constructor dependency uses an explicit `@Inject(TOKEN_OR_CLASS)`.

**Tech Stack:** Bun 1.4.4, NestJS 12.2 (Express), `@nestjs/testing`, vitest 5 (`bun --bun vitest run`), `bun:sqlite`, ts-pattern, remeda.

**Spec:** `docs/superpowers/specs/2026-10-25-updater-modules-design.md`

## Global Constraints

- No behaviour change: same routes, bodies, responses, status codes, headers, logs, messages. User-facing strings stay in French and are copied verbatim when code moves.
- Stored rollbacks keep their exact format: `data.kind` is `"pull" | "version" | "recipe"` with the current fields; `"recipe"` is the Authentik minor strategy's rollback.
- `config.yml` keeps `recipe: authentik`; `UpdateMode` in `@shared/updater-api` is unchanged. Nothing in `shared/` changes.
- SQLite tables and contents unchanged; all stores share one connection.
- Env vars unchanged: `UPDATER_TOKEN`, `PORT` (default `8080`), `UPDATER_ROOT` (default `/root`), `UPDATER_CONFIG` (default `/root/updater/config.yml`), `UPDATER_DATA` (default `/data`). Missing token → `console.error("UPDATER_TOKEN est requis")`, exit 1, before listening. Start-up logs `console.warn(\`${n} tâche(s) marquée(s) interrompue(s)\`)` when n > 0. SIGTERM stops the scheduler and closes the app, then exits 0.
- Explicit `@Inject(...)` on every constructor parameter of every provider, guard and controller.
- Pure functions stay functions (`versions`, `env-file`, `image-ref`, `health`, `docker-cli` parsing, `planUpdateAll`, `discoverStacks`, `authentikTarget`). No injectable wrapper around them.
- Comments in English. Each `*.module.ts` starts with a header comment saying what the module is for; functions whose role is not obvious get a one-line doc comment. Not every line.
- No `forwardRef`. Module imports follow: config, database, docker → stacks(database) → jobs(database), strategies(docker), detection(config, docker, stacks, strategies, jobs), update(config, docker, stacks, strategies, detection, jobs), scheduler(detection, jobs). Strategies imports only `DockerModule`: its use of stacks is types and helpers, no injected provider.
- Tests stay next to the file they test. `src/test/fakes.ts` stays shared. Existing assertions keep their meaning when rewired.
- Verification after every task, from `updater/`: `bun run test` and `bun run typecheck` pass; from the repo root: `npx oxlint updater` and `npx oxfmt --check updater` pass.
- Commits: the commit step of each task runs only if your human partner authorised commits for this execution; otherwise skip it.

## Review Focus

1. **Rollbacks saved before the refactor** (raw JSON rows of each kind in `rollbacks`) must restore through the matching strategy after deploy. → Task 3, `stack-updater.test.ts` "rollbacks stored before the refactor restore through their strategy".
2. **The existing `updater.db` on CT 100** is opened by the new code: schema must be identical and rows readable. → Task 2, `database.test.ts`.
3. **Start-up order**: interrupted jobs must be marked before the scheduler's start-up check creates its job (otherwise the fresh check would be marked interrupted), and `app.close()` must stop the scheduler timers. → Task 5, `lifecycle.test.ts`.
4. **Booting under Bun, outside vitest** (decorators, DI resolution, `reflect-metadata`), plus the missing-token exit. → Task 5 smoke step.
5. **Strategy choice edge cases**: recipe stack with only a sidecar changed → pull; Authentik patch → version; Authentik minor → recipe; version stack whose `version` config disappeared → fails with `configuration de version absente`. → Task 3, `strategies.test.ts` and `stack-updater.test.ts`.

---

## Target layout

```
updater/src/
  main.ts                     env check, NestFactory, listen, SIGTERM
  app.module.ts               AppModule.forRoot(env): guard, filter, imports all modules
  app.controller.ts           GET /health
  auth.guard.ts               AuthGuard, tokenMatches            (from http/auth.guard.ts)
  error.filter.ts             ErrorFilter                        (from http/controllers.ts)
  app.test.ts                 HTTP tests                         (from http/http.test.ts)
  lifecycle.test.ts           start-up / shutdown order
  common/runtime.ts           ENV, CLOCK, FETCH tokens, Env, readEnv
  common/runtime.module.ts    RuntimeModule.forRoot(env), @Global
  common/errors.ts            NotFoundError, BadRequestError, messageOf
  config/                     config.ts (schema, parseConfig, stackConfig), config.service.ts, config.module.ts
  database/                   database.ts (DATABASE, openDatabase), database.module.ts
  docker/                     docker.ts (types, DOCKER, isUp), docker-cli.ts, registry.ts (REGISTRY), image-ref.ts, versions.ts, docker.module.ts
  stacks/                     discovery.ts, env-file.ts, stack-status.store.ts, rollback.store.ts, stack-context.ts, fail.ts, compose.ts, stacks.module.ts
  strategies/                 strategy.ts, pull.strategy.ts, version.strategy.ts, authentik-minor.strategy.ts, authentik-target.ts, strategies.ts, strategies.module.ts
  detection/                  detection.service.ts, detection.controller.ts, detection.module.ts
  update/                     update.service.ts, stack-updater.ts, health.ts, update-all.ts, update.controller.ts, update.module.ts
  jobs/                       job.store.ts, job-runner.ts, jobs.controller.ts, jobs.module.ts
  scheduler/                  scheduler.service.ts, scheduler.module.ts
  test/fakes.ts, test/module.ts
```

Each `*.test.ts` sits next to its file.

---

### Task 1: Move the pure files into module folders

No logic change: `git mv` and import paths only.

**Files:**
- Move (with their `.test.ts`): `config.ts` → `config/config.ts`; `docker.ts` → `docker/docker.ts` (no test); `docker-cli.ts`, `registry.ts`, `image-ref.ts`, `versions.ts` → `docker/`; `env-file.ts`, `discovery.ts` → `stacks/`; `health.ts`, `update-all.ts` → `update/`
- Modify: every importer (`detection.ts`, `update.ts`, `authentik.ts`, `service.ts`, `jobs.ts`, `scheduler.ts`, `main.ts`, `http/*.ts`, `test/fakes.ts`, the moved files and their tests)

**Interfaces:**
- Consumes: nothing.
- Produces: the paths above; exported names unchanged.

- [ ] **Step 1: Move the files with `git mv`** (keep history), one command per file pair.
- [ ] **Step 2: Fix imports** until `bun run typecheck` (from `updater/`) passes. Expected: no errors.
- [ ] **Step 3: Run the tests.** `bun run test` → all pass, same test count as before the move (record it first with `bun run test` on a clean tree).
- [ ] **Step 4: Lint and format.** From the repo root: `npx oxlint updater` → 0 errors; `npx oxfmt --check updater` → clean.
- [ ] **Step 5: Commit**

```bash
git add -A updater/src
git commit -m "refactor(updater): move pure helpers into module folders"
```

---

### Task 2: Database module and store split

Replace `Store` with `openDatabase` plus three stores. Tables and SQL unchanged.

**Files:**
- Create: `updater/src/database/database.ts`, `updater/src/database/database.test.ts`
- Create: `updater/src/stacks/stack-status.store.ts`, `stacks/stack-status.store.test.ts`
- Create: `updater/src/stacks/rollback.store.ts`, `stacks/rollback.store.test.ts`
- Create: `updater/src/jobs/job.store.ts`, `jobs/job.store.test.ts`
- Delete: `updater/src/store.ts`, `updater/src/store.test.ts` (its tests move to the three store tests)
- Modify: `jobs.ts`, `scheduler.ts`, `detection.ts`, `update.ts`, `authentik.ts`, `service.ts`, `main.ts` and their tests

**Interfaces:**
- Produces:
  - `database/database.ts`: `export const DATABASE = Symbol("DATABASE")`; `export function openDatabase(file: string): Database` — runs `PRAGMA journal_mode = WAL` and the five `CREATE TABLE IF NOT EXISTS` statements copied verbatim from `Store`'s constructor.
  - `stacks/stack-status.store.ts`: `@Injectable() class StackStatusStore`, `constructor(@Inject(DATABASE) db: Database)`; methods `getMeta(key)`, `setMeta(key, value)`, `stackStatuses()`, `saveStackStatuses(list)`, `saveStackStatus(status)` — bodies from `Store`.
  - `stacks/rollback.store.ts`: `RollbackState` (moved verbatim with its field comments), `export type RollbackData = RollbackState["data"]`, `export type RollbackKind = RollbackData["kind"]`; `@Injectable() class RollbackStore` with `save(state: RollbackState): void`, `get(stack: string): RollbackState | null`, `delete(stack: string): void` (bodies of `saveRollback` / `rollback` / `deleteRollback`).
  - `jobs/job.store.ts`: `@Injectable() class JobStore` with `createJob`, `appendLog`, `setSteps`, `finishJob`, `job`, `jobLog`, `history`, `markInterrupted`, `purgeLogs` — names, signatures and bodies from `Store`.
  - Interim (replaced in Tasks 3–4): `StackContext.store` becomes `rollbacks: RollbackStore`; `checkAll` input becomes `{ root, config, statuses: StackStatusStore, rollbacks: RollbackStore }`; `UpdaterServiceDeps.store` becomes `statuses`, `rollbacks`, `jobStore`; `JobRunner` takes `JobStore`; `startScheduler(service, jobs, statuses: StackStatusStore, jobStore: JobStore, now)`.

- [ ] **Step 1: Write the failing database test** in `database/database.test.ts`

```ts
// Frozen copy of the statements the pre-refactor Store ran: the deployed updater.db was created with these.
const LEGACY_SCHEMA = [/* the five CREATE TABLE IF NOT EXISTS statements, copied from store.ts before deleting it */];

const tables = (db: Database) =>
  db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

test("openDatabase creates exactly the pre-refactor tables", () => {
  const legacy = new Database(":memory:");
  for (const statement of LEGACY_SCHEMA) legacy.run(statement);
  expect(tables(openDatabase(":memory:"))).toEqual(tables(legacy));
});

test("reopening an existing file keeps its rows", async () => {
  const file = join(await tempDir(), "updater.db");
  const first = openDatabase(file);
  const job = new JobStore(first).createJob({ kind: "update", user: "a@b.c", steps: [], startedAt: "2026-10-24T10:00:00.000Z" });
  new RollbackStore(first).save({ stack: "web", to: "1.0", major: false, running: true, data: { kind: "pull", services: [] } });
  first.close();
  const second = openDatabase(file);
  expect(new JobStore(second).job(job.id)).toMatchObject({ kind: "update", user: "a@b.c" });
  expect(new RollbackStore(second).get("web")).toMatchObject({ to: "1.0" });
});
```

- [ ] **Step 2: Run it** — `bun --bun vitest run src/database` → FAIL (module not found).
- [ ] **Step 3: Implement `openDatabase` and the three stores**; move `store.test.ts` cases into the three store tests (`create, append logs…`, `history…`, `markInterrupted…`, `purgeLogs…` → job store; `rollback round-trip` → rollback store using `save/get/delete`; `saveStackStatuses replaces all; meta; setSteps` → split: statuses + meta in stack-status store, `setSteps` in job store). Each store test builds its store on `openDatabase(":memory:")`.
- [ ] **Step 4: Switch every consumer to the new stores**, delete `store.ts` and `store.test.ts`. `main.ts`: `mkdirSync(dataDir, { recursive: true })` then one `openDatabase(join(dataDir, "updater.db"))` shared by the three stores; `markInterrupted` called on `JobStore` with the same log line.
- [ ] **Step 5: Run everything** — `bun run test` and `bun run typecheck` → pass; lint/format from root → clean.
- [ ] **Step 6: Commit**

```bash
git add -A updater/src
git commit -m "refactor(updater): split the store by domain over one connection"
```

---

### Task 3: Update strategies and the shared `StackUpdater`

Extract pull / version / Authentik minor behind `UpdateStrategy`, move the shared flow into `StackUpdater`, move the Authentik target choice out of detection. `StackContext` keeps only `stack`, `config`, `status`, `log`.

**Files:**
- Create: `updater/src/common/runtime.ts` (only `CLOCK` and `FETCH` for now)
- Create: `updater/src/stacks/stack-context.ts`, `stacks/fail.ts`, `stacks/compose.ts`
- Create: `updater/src/strategies/strategy.ts`, `pull.strategy.ts`, `version.strategy.ts`, `authentik-minor.strategy.ts`, `authentik-target.ts`, `strategies.ts`
- Create tests: `strategies/authentik-minor.strategy.test.ts` (from `authentik.test.ts`), `strategies/authentik-target.test.ts` (the `authentikTarget` case from `docker/versions.test.ts`), `strategies/strategies.test.ts`
- Create: `updater/src/update/stack-updater.ts`, `update/stack-updater.test.ts` (from `update.test.ts`)
- Modify: `docker/docker.ts` (add `DOCKER`, `isUp`), `docker/registry.ts` (add `REGISTRY`), `docker/versions.ts` (export `compareNumbers`, `highest`, `Candidate`; remove `authentikTarget`), `update/health.ts` (add `WAIT_HEALTHY`, `WaitHealthy`), `detection.ts`, `service.ts`, `service.test.ts`, `detection.test.ts`
- Delete: `update.ts`, `update.test.ts`, `authentik.ts`, `authentik.test.ts`

**Interfaces:**
- Consumes: `RollbackStore`, `RollbackData`, `RollbackKind` (Task 2).
- Produces:
  - `common/runtime.ts`: `export const CLOCK = Symbol("CLOCK")`, `export const FETCH = Symbol("FETCH")`.
  - `docker/docker.ts`: `export const DOCKER = Symbol("DOCKER")`; `export const isUp = (c: ContainerState): boolean` (running or restarting; keep the "crash-looping" comment). `docker/registry.ts`: `export const REGISTRY = Symbol("REGISTRY")`.
  - `update/health.ts`: `export type WaitHealthy = typeof waitHealthy`; `export const WAIT_HEALTHY = Symbol("WAIT_HEALTHY")`.
  - `stacks/stack-context.ts`: `export type StackContext = { stack: DiscoveredStack; config: StackConfig; status: StackStatus; log: LogSink }`.
  - `stacks/fail.ts`: `export function fail(message: string): never` (throws the private `StepFailed`).
  - `stacks/compose.ts`: `export async function runCompose(docker: Docker, ctx: StackContext, args: string[]): Promise<void>` — body of today's `runCompose`.
  - `strategies/strategy.ts`:

```ts
export type RollbackOf<K extends RollbackKind> = Extract<RollbackData, { kind: K }>;

export type Plan<K extends RollbackKind = RollbackKind> = {
  /** Version a rollback brings back, shown to the user. */
  rollbackTo: string;
  rollback: RollbackOf<K>;
  /** Writes the change; runs after the `before` commands and before pull/up. */
  apply(): Promise<void>;
};

/** One way of updating a stack. Holds only what differs; the shared flow is StackUpdater. */
export interface UpdateStrategy<K extends RollbackKind = RollbackKind> {
  /** The `data.kind` its rollbacks are stored under. */
  readonly kind: K;
  /** Checks the target and returns the plan. Fails (via `fail`) before any file change. */
  prepare(ctx: StackContext, before: ContainerState[]): Promise<Plan<K>>;
  /** Text the user confirms before applying; only Authentik minor has one. */
  preview?(ctx: StackContext): Promise<string>;
  /** Puts back what `prepare` saved, then recreates the containers when `start`. */
  restore(ctx: StackContext, data: RollbackOf<K>, start: boolean): Promise<void>;
}

export const notNewerMessage = /* moved verbatim from update.ts */;
```

  - `strategies/pull.strategy.ts`: `export const rollbackTag` (moved); `@Injectable() class PullStrategy implements UpdateStrategy<"pull">`, `constructor(@Inject(DOCKER) docker: Docker)`. `prepare`: `composeServices`, then today's `savePullRollback` candidate selection and `docker.tag` calls (not the stale-tag removal, not the save); `rollbackTo = (status.mode === "pull" ? status.current : null) ?? "l'image précédente"`; `apply` does nothing. `restore`: today's `pull` branch (re-tag, `up -d` when `start`).
  - `strategies/version.strategy.ts`: `@Injectable() class VersionStrategy implements UpdateStrategy<"version">`, no constructor deps. `prepare`: `config.version ?? fail("configuration de version absente")`, `status.available ?? fail("aucune version disponible")`, read the variable (`variable X absente de F`), `notNewerMessage` check, `rollbackTo = value`; `apply` logs `== VAR=target` and writes the file. `restore`: today's `version` branch (`up -d --pull missing` when `start`).
  - `strategies/authentik-minor.strategy.ts`: `upstreamComposeUrl`, `normalizeCompose` (moved); `@Injectable() class AuthentikMinorStrategy implements UpdateStrategy<"recipe">`, `constructor(@Inject(FETCH) fetchFn: typeof fetch)`. Today's private `prepare` becomes a private `plan(ctx)`; `prepare` fails with its error when not ok and returns the `recipe` rollback data; `apply` writes upstream compose then the variable with today's log lines; `preview` returns the diff or fails with the error; `restore`: today's `recipe` branch.
  - `strategies/authentik-target.ts`: `export function authentikTarget(current: string, tags: string[]): { kind: "patch" | "minor"; to: string } | null` (moved from `versions.ts`).
  - `strategies/strategies.ts`: `@Injectable() class Strategies`, `constructor(@Inject(PullStrategy) pull, @Inject(VersionStrategy) version, @Inject(AuthentikMinorStrategy) authentikMinor)`:
    - `forUpdate(status: StackStatus, config: StackConfig): UpdateStrategy` — `pull` mode → pull; `version`/`recipe` with `status.available === null` **and** `config.version` set → pull; `recipe` and today's `isAuthentikMinor(status)` → authentikMinor; otherwise version.
    - `restore(ctx: StackContext, data: RollbackData, start: boolean): Promise<void>` — dispatches on `data.kind` with ts-pattern `.exhaustive()`.
    - `target(config: StackConfig, kind: ServiceKind, tag: string, tags: string[]): { to: string | null; needsConfirm: boolean }` — `config.recipe === "authentik" && kind === "variable"` → `authentikTarget`, `needsConfirm` when its kind is `"minor"`; otherwise `{ to: newestAbove(tag, tags), needsConfirm: false }`.
  - `update/stack-updater.ts`: `@Injectable() class StackUpdater`, `constructor(@Inject(DOCKER) docker, @Inject(RollbackStore) rollbacks, @Inject(Strategies) strategies, @Inject(WAIT_HEALTHY) wait: WaitHealthy)`; `update(ctx: StackContext): Promise<"success" | "failed">`; `rollback(ctx: StackContext): Promise<"success" | "failed">`. Private helpers: today's `runBeforeCommands`, `pullAndStart`, `checkHealth`, `isStackUp`.
  - Interim: `DetectionDeps` gains `strategies: Strategies`; `UpdaterService` builds `Strategies` and `StackUpdater` by hand from its deps (`wait: waitHealthy`) and calls `strategies.forUpdate(...).preview` instead of `authentikPreview`.

`StackUpdater.update` order (keeps today's sequencing; must not be rearranged):

```
try:
  before = docker.containers(dir)
  strategy = strategies.forUpdate(status, config)
  plan = strategy.prepare(ctx, before)            // fails here leave nothing changed
  if plan.rollback.kind == "pull" and previous stored rollback is "pull":
    removeImage(rollbackTag) for each previous service not in plan.rollback.services
  rollbacks.save({ stack, to: plan.rollbackTo, major: status.major, running: isStackUp(before), data: plan.rollback })
  runBeforeCommands(ctx)
  plan.apply()
  pullAndStart(ctx, before)
  return "success"
catch: log message, return "failed"
```

`StackUpdater.rollback`: today's `rollbackStack` with `restore(...)` replaced by `strategies.restore(ctx, state.data, state.running)`; pull tag removal and `rollbacks.delete` stay here.

- [ ] **Step 1: Write the failing strategy-choice and target tests** in `strategies/strategies.test.ts`

```ts
const baseConfig: StackConfig = { confirm: false, last: false, before: [], beforeOnlyOnMajor: false };
const versionCfg = { ...baseConfig, version: { file: ".env", variable: "VERSION" } };
const recipeCfg = { ...baseConfig, recipe: "authentik" as const, version: { file: ".env", variable: "AUTHENTIK_TAG" } };
const strategies = new Strategies(new PullStrategy(new FakeDocker()), new VersionStrategy(), new AuthentikMinorStrategy(fetch));

test.each([
  ["pull stack", { mode: "pull" }, baseConfig, "pull"],
  ["version stack with a target", { mode: "version", available: "v2.0.0" }, versionCfg, "version"],
  ["version stack, sidecar only", { mode: "version", available: null }, versionCfg, "pull"],
  ["authentik patch", { mode: "recipe", needsConfirm: false, current: "2026.8.3", available: "2026.8.4" }, recipeCfg, "version"],
  ["authentik minor", { mode: "recipe", needsConfirm: true, current: "2026.8.4", available: "2026.10.2" }, recipeCfg, "recipe"],
  ["authentik, sidecar only", { mode: "recipe", available: null }, recipeCfg, "pull"],
  ["version config gone", { mode: "version", available: null }, baseConfig, "version"],
] as const)("forUpdate: %s", (_, status, config, kind) => {
  expect(strategies.forUpdate({ ...baseStatus, ...status }, config).kind).toBe(kind);
});

test("target", () => {
  const tags = ["2026.8.3", "2026.8.4", "2026.10.0", "2026.10.2"];
  expect(strategies.target(recipeCfg, "variable", "2026.8.4", tags)).toEqual({ to: "2026.10.2", needsConfirm: true });
  expect(strategies.target(recipeCfg, "variable", "2026.8.3", tags)).toEqual({ to: "2026.8.4", needsConfirm: false });
  expect(strategies.target(recipeCfg, "variable", "2026.12.1", tags)).toEqual({ to: null, needsConfirm: false });
  expect(strategies.target(recipeCfg, "literal", "1.0.0", ["1.0.0", "1.1.0"])).toEqual({ to: "1.1.0", needsConfirm: false });
  expect(strategies.target(versionCfg, "variable", "v1.0.0", ["v1.0.0", "v1.2.0"])).toEqual({ to: "v1.2.0", needsConfirm: false });
});
```

(`baseStatus` as in today's `update.test.ts`.)

- [ ] **Step 2: Run it** — `bun --bun vitest run src/strategies` → FAIL (modules missing).
- [ ] **Step 3: Implement** `runtime.ts` tokens, `stack-context.ts`, `fail.ts`, `compose.ts`, the strategy files and `strategies.ts` per the Interfaces block; move `authentikTarget` and its test.
- [ ] **Step 4: Run** `bun --bun vitest run src/strategies` → PASS.
- [ ] **Step 5: Move `update.test.ts` to `update/stack-updater.test.ts`.** `ctx()` returns `{ stack, config, status, log }`; a `makeUpdater(wait = async () => ({ ok: true }))` builds `new StackUpdater(docker, rollbacks, strategies, wait)` over `rollbacks = new RollbackStore(db)`, `db = openDatabase(":memory:")`. `updateStack(ctx)` → `updater.update(ctx)`, `rollbackStack(ctx)` → `updater.rollback(ctx)`, `store.rollback(x)` → `rollbacks.get(x)`, `store.saveRollback` → `rollbacks.save`. The `rollbackTag` test moves to the pull strategy's import. Add:

```ts
test("a version stack whose version config disappeared fails before any change", async () => {
  expect(await makeUpdater().update(ctx({ status: { mode: "version", available: null } }))).toBe("failed");
  expect(logs).toContain("configuration de version absente");
  expect(docker.composeCalls).toEqual([]);
  expect(rollbacks.get("stirling")).toBeNull();
});

test.each([
  {
    kind: "pull",
    json: '{"stack":"stirling","to":"l\'image précédente","major":false,"running":true,"data":{"kind":"pull","services":[{"service":"app","image":"stirling/app:latest"}]}}',
    compose: [["up", "-d"]],
  },
  {
    kind: "version",
    json: '{"stack":"stirling","to":"v3.4.0","major":false,"running":true,"data":{"kind":"version","file":".env","variable":"VERSION","value":"v3.4.0"}}',
    compose: [["up", "-d", "--pull", "missing"]],
  },
  {
    kind: "recipe",
    json: '{"stack":"stirling","to":"v3.4.0","major":true,"running":true,"data":{"kind":"recipe","file":".env","variable":"VERSION","value":"v3.4.0","compose":"services: {old: {}}\\n"}}',
    compose: [["up", "-d", "--pull", "missing"]],
  },
])("rollbacks stored before the refactor restore through their strategy ($kind)", async ({ kind, json, compose }) => {
  await writeFile(join(dir, ".env"), "VERSION=v3.5.0\n");
  db.query("INSERT INTO rollbacks (stack, json) VALUES (?, ?)").run("stirling", json);
  expect(await makeUpdater().rollback(ctx())).toBe("success");
  expect(docker.composeCalls.map((c) => c.args)).toEqual(compose);
  if (kind === "pull") expect(docker.tagCalls).toEqual([{ source: rollbackTag("stirling", "app"), target: "stirling/app:latest" }]);
  if (kind !== "pull") expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  if (kind === "recipe") expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe("services: {old: {}}\n");
  expect(rollbacks.get("stirling")).toBeNull();
});
```

- [ ] **Step 6: Move `authentik.test.ts` to `strategies/authentik-minor.strategy.test.ts`.** Preview cases call `strategy.preview(ctx())`: success → resolves to the diff (same `toContain` assertions; the `from`/`to` check becomes the `requested` URLs check that is already there); refusals → `rejects.toThrow(<same message>)`. Update cases run through `new StackUpdater(docker, rollbacks, strategies, async () => ({ ok: true }))` with the recipe status and config, so the strategy is chosen by `forUpdate`; `store.rollback` → `rollbacks.get`.
- [ ] **Step 7: Rewire detection and the service.** `detection.ts` uses `strategies.target(...)`; `Checked` becomes `{ status: ServiceStatus; needsConfirm: boolean }`; stack `needsConfirm = config.confirm || major || checked.some((c) => c.status.update && c.needsConfirm)`. `detection.test.ts` adds `strategies` to `deps`. `UpdaterService` builds `Strategies`/`StackUpdater` by hand; `runUpdate` calls `stackUpdater.update(ctx)`; the confirm path calls `strategy.preview` inside a try that maps any throw to `new BadRequestError(messageOf(error))`.
- [ ] **Step 8: Delete** `update.ts`, `update.test.ts`, `authentik.ts`, `authentik.test.ts`. Run `bun run test`, `bun run typecheck`, root lint/format → all pass. `grep -rn "authentikTarget\|isAuthentikMinor\|authentikPreview" updater/src | grep -v "src/strategies/"` → no output.
- [ ] **Step 9: Commit**

```bash
git add -A updater/src
git commit -m "refactor(updater): update strategies behind one interface"
```

---

### Task 4: Nest modules, services and per-module controllers

Nest builds the app. `UpdaterService` and `http/` disappear. `main.ts` still marks interrupted jobs and starts the scheduler explicitly (moved to lifecycle hooks in Task 5).

**Files:**
- Modify: `common/runtime.ts` (add `Env`, `ENV`, `readEnv`); Create: `common/runtime.module.ts`, `common/errors.ts`
- Create: `config/config.service.ts`, `config/config.service.test.ts` (the loader test from `config.test.ts`), `config/config.module.ts`; Modify: `config/config.ts` (remove `createConfigLoader`), `config/config.test.ts`
- Create: `database/database.module.ts`, `docker/docker.module.ts`, `stacks/stacks.module.ts`, `strategies/strategies.module.ts`
- Create: `jobs/job-runner.ts` + `job-runner.test.ts` (`git mv` from `jobs.ts`/`jobs.test.ts`), `jobs/jobs.controller.ts`, `jobs/jobs.module.ts`
- Create: `detection/detection.service.ts` + `detection.service.test.ts` (from `detection.ts`/`detection.test.ts` and the detection parts of `service.ts`/`service.test.ts`), `detection/detection.controller.ts`, `detection/detection.module.ts`
- Create: `update/update.service.ts` + `update.service.test.ts` (rest of `service.ts`/`service.test.ts`), `update/update.controller.ts`, `update/update.module.ts`
- Create: `scheduler/scheduler.service.ts` + `scheduler.service.test.ts` (from `scheduler.ts`/`scheduler.test.ts`), `scheduler/scheduler.module.ts`
- Create: `app.module.ts`, `app.controller.ts`, `auth.guard.ts`, `error.filter.ts`, `app.test.ts` (from `http/http.test.ts`), `test/module.ts`
- Modify: `main.ts`, `update/update-all.ts` (import `JobContext` from `../jobs/job-runner`)
- Delete: `service.ts`, `service.test.ts`, `detection.ts`, `detection.test.ts`, `jobs.ts`, `jobs.test.ts`, `scheduler.ts`, `scheduler.test.ts`, `http/`

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces:
  - `common/runtime.ts`: `export type Env = { token: string; port: number; root: string; configPath: string; dataDir: string }`; `export const ENV = Symbol("ENV")`; `export function readEnv(vars: Record<string, string | undefined>): Env | null` — `null` when `UPDATER_TOKEN` is missing or empty; defaults from Global Constraints.
  - `common/runtime.module.ts`: `@Global() @Module({}) class RuntimeModule { static forRoot(env: Env): DynamicModule }` providing and exporting `ENV` (`useValue: env`), `CLOCK` (`() => new Date()`), `FETCH` (`globalThis.fetch`). Header: values from the outside world every module may need, global so tests replace them in one place.
  - `common/errors.ts`: `NotFoundError`, `BadRequestError` (moved from `service.ts`), `messageOf(error: unknown): string`.
  - `config/config.service.ts`: `@Injectable() class ConfigService`, `constructor(@Inject(ENV) env: Env)`; `load(): Promise<{ config: UpdaterConfig; error: string | null }>` — today's `createConfigLoader` body, `lastGood` as a private field.
  - `database/database.module.ts`: provider `DATABASE` with `useFactory: (env: Env) => { mkdirSync(env.dataDir, { recursive: true }); return openDatabase(join(env.dataDir, "updater.db")); }`, `inject: [ENV]`; exports `DATABASE`.
  - `docker/docker.module.ts`: `DOCKER` (`useFactory: createDockerCli`), `REGISTRY` (`useFactory: () => createHttpRegistry()`); exports both.
  - `stacks/stacks.module.ts`: imports `DatabaseModule`; provides/exports `StackStatusStore`, `RollbackStore`.
  - `strategies/strategies.module.ts`: imports `DockerModule`; provides the three strategies and `Strategies`; exports `Strategies`.
  - `jobs/job-runner.ts`: `@Injectable() class JobRunner`, `constructor(@Inject(JobStore) store, @Inject(CLOCK) now: () => Date)`; `BusyError`, `JobContext` unchanged. `jobs/jobs.controller.ts`: `JobsController` with `GET jobs/:id`, `GET jobs/:id/events`, `GET history` and `parseId`/`parseCursor`, bodies from `UpdaterController`; `job` and `history` read `JobStore`, `events` reads `JobRunner`. `jobs.module.ts`: imports `DatabaseModule`; exports `JobStore`, `JobRunner`.
  - `detection/detection.service.ts`: `@Injectable() class DetectionService`, `constructor(@Inject(ENV) env, @Inject(ConfigService) config, @Inject(DOCKER) docker, @Inject(REGISTRY) registry, @Inject(StackStatusStore) statuses, @Inject(RollbackStore) rollbacks, @Inject(Strategies) strategies, @Inject(JobRunner) jobs, @Inject(CLOCK) now)`:
    - `stacks(): StacksResponse` (today's `UpdaterService.stacks` + `withRollback`, keep its comment)
    - `check(user: string | null): Job`
    - `lastCheck(): string | null` (`statuses.getMeta("lastCheck")`)
    - `checkAll(config: UpdaterConfig, log: LogSink): Promise<StackStatus[]>`
    - `checkStack(stack: DiscoveredStack, config: StackConfig): Promise<StackStatus>` — reads the rollback from `RollbackStore` itself
    - `recheck(stack: DiscoveredStack, config: StackConfig): Promise<void>` — `checkStack` then `saveStackStatus`
    - `kindOf`, `baseStatus`, `checkService`, `safeCheckService` stay private or module-level functions.
  - `detection.controller.ts`: `DetectionController` — `GET stacks`, `POST checks` (`@HttpCode(200)`), bodies from `UpdaterController`.
  - `update/update.service.ts`: `@Injectable() class UpdateService`, `constructor(@Inject(ENV) env, @Inject(ConfigService) config, @Inject(StackStatusStore) statuses, @Inject(RollbackStore) rollbacks, @Inject(DetectionService) detection, @Inject(StackUpdater) updater, @Inject(Strategies) strategies, @Inject(JobRunner) jobs)`; `update(name: string, body: UpdateBody, user: string | null): Promise<UpdateResponse>`, `rollback(name: string, user: string | null): Promise<Job>`, `updateAll(user: string | null): Job`; private `lookup`, `singleStep`, `runUpdate`, `runRollback` from today's service.
  - `update.controller.ts`: `UpdateController` — `POST stacks/:name/update`, `POST stacks/:name/rollback`, `POST updates`, all `@HttpCode(200)`, bodies from `UpdaterController` (body validation → `BadRequestError("Requête invalide")`).
  - `update.module.ts`: imports Config, Docker, Stacks, Strategies, Detection, Jobs; provides `UpdateService`, `StackUpdater`, `{ provide: WAIT_HEALTHY, useValue: waitHealthy }`.
  - `scheduler/scheduler.service.ts`: `@Injectable() class SchedulerService`, `constructor(@Inject(DetectionService) detection, @Inject(JobRunner) jobs, @Inject(JobStore) jobStore, @Inject(CLOCK) now)`; `start(): void` (today's `startScheduler` body; reads `detection.lastCheck()`), `stop(): void` (clears the timers). `scheduler.module.ts`: imports Detection, Jobs.
  - `auth.guard.ts`: `tokenMatches` unchanged; `AuthGuard` takes `@Inject(ENV) env: Env` and compares with `env.token`. `error.filter.ts`: `ErrorFilter` and `errorStatus` unchanged.
  - `app.module.ts`: `@Module({ imports: [ConfigModule, DatabaseModule, DockerModule, StacksModule, StrategiesModule, JobsModule, DetectionModule, UpdateModule, SchedulerModule], controllers: [AppController], providers: [{ provide: APP_GUARD, useClass: AuthGuard }, { provide: APP_FILTER, useClass: ErrorFilter }] }) class AppModule { static forRoot(env: Env): DynamicModule /* adds RuntimeModule.forRoot(env) */ }`.
  - `test/module.ts`:

```ts
export type TestOptions = {
  env?: Partial<Env>;
  database?: Database;   // default openDatabase(":memory:")
  docker?: Docker;       // default new FakeDocker()
  registry?: Registry;   // default new FakeRegistry()
  fetch?: typeof fetch;  // default: rejects with "no network in tests"
  now?: () => Date;      // default: real clock
  wait?: WaitHealthy;    // default: real waitHealthy
};
export function testEnv(overrides?: Partial<Env>): Env; // token "secret-token", port 0, paths under "/nonexistent"
export function testModuleBuilder(options?: TestOptions): TestingModuleBuilder; // AppModule.forRoot(testEnv(env)) + overrideProvider for each option
export const testModule = (options?: TestOptions): Promise<TestingModule> => testModuleBuilder(options).compile();
```

- `main.ts` (interim): `readEnv(process.env)` → on `null` the exact error and `process.exit(1)`; `NestFactory.create(AppModule.forRoot(env), { logger: ["error", "warn"] })`; `app.get(JobStore).markInterrupted(...)` with the same warn line; `listen(env.port, "0.0.0.0")` and the same `updater listening on 0.0.0.0:${port}` line; `app.get(SchedulerService).start()`; SIGTERM → `scheduler.stop()`, then `app.close()` → `process.exit(0)`.

- [ ] **Step 1: Write the HTTP test against the Nest-built app.** `git mv src/http/http.test.ts src/app.test.ts`. Replace `createApp(stub, TOKEN)` with:

```ts
const moduleRef = await testModuleBuilder()
  .overrideProvider(DetectionService).useValue({ stacks: stub.stacks })
  .overrideProvider(UpdateService).useValue({ update: stub.update })
  .overrideProvider(JobStore).useValue({ history: stub.history })
  .overrideProvider(JobRunner).useValue({ events: stub.events })
  .overrideProvider(SchedulerService).useValue({})
  .compile();
app = moduleRef.createNestApplication({ logger: ["error", "warn"] });
```

`stub` keeps today's functions (drop the `as unknown as UpdaterService` cast); every `test(...)` body is unchanged. `BusyError` comes from `./jobs/job-runner`, `NotFoundError` from `./common/errors`.

- [ ] **Step 2: Run it** — `bun --bun vitest run src/app.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement runtime, errors, config service, and every module/provider/controller** per the Interfaces block, each `*.module.ts` with its header comment. Create `test/module.ts`.
- [ ] **Step 4: Run** `bun --bun vitest run src/app.test.ts` → PASS (7 tests). This proves the routes, auth, error mapping and SSE are unchanged.
- [ ] **Step 5: Rewire the service-level tests through `testModule`.**
  - `detection.service.test.ts`: `moduleRef = await testModule({ docker, registry, now: () => NOW, env: { root } })`, `detection = moduleRef.get(DetectionService)`. `checkStack(stack, cfg, null, deps)` → `detection.checkStack(stack, cfg)`; "rollback state is exposed" first calls `moduleRef.get(RollbackStore).save({ stack: "rb", ... })`; `checkAll({ root, config, store }, deps, log)` → `detection.checkAll(cfg, log)` and reads `moduleRef.get(StackStatusStore).getMeta("lastCheck")`. Move here from `service.test.ts`: "check stores the config error and keeps the previous config".
  - `update.service.test.ts`: the rest of `service.test.ts`, built with `testModule({ docker, registry, fetch: fetchFn, now: () => NOW, env: { root, configPath } })`. `service.update/rollback/updateAll` → `UpdateService`; `service.check` → `DetectionService.check`; `service.stacks()` → `DetectionService.stacks()`; `service.job/history` → `JobStore.job/history`; `jobs.idle()` on `moduleRef.get(JobRunner)`.
  - `config.service.test.ts`: "loader handles missing, invalid and recovered files" with `const config = new ConfigService(testEnv({ configPath }))` and `config.load()` in place of the loader function.
  - `scheduler.service.test.ts`: `new SchedulerService(detection, jobs, jobStore, now)` with `detection = { check, lastCheck: () => lastCheck } as unknown as DetectionService` and a `let lastCheck: string | null` the tests set instead of `store.setMeta("lastCheck", ...)`; `startScheduler(...)` → `scheduler.start()`, the returned stop → `scheduler.stop()`; `vi.spyOn(jobStore, "purgeLogs")`.
  - `job-runner.test.ts`: `new JobRunner(new JobStore(openDatabase(":memory:")), now)`; spies target the `JobStore`.
- [ ] **Step 6: Rewrite `main.ts`** (interim, see Interfaces) and delete `service.ts`, `service.test.ts`, `detection.ts`, `detection.test.ts`, `jobs.ts`, `jobs.test.ts`, `scheduler.ts`, `scheduler.test.ts`, `http/`.
- [ ] **Step 7: Verify.** `bun run test` → all pass, test count ≥ the count recorded in Task 1; `bun run typecheck` → clean; root lint/format → clean. `ls updater/src/*.ts` → only `main.ts`, `app.module.ts`, `app.controller.ts`, `auth.guard.ts`, `error.filter.ts`, `app.test.ts`. Then run the boot smoke from Task 5 Step 6 (all its expectations hold already at this point).
- [ ] **Step 8: Commit**

```bash
git add -A updater/src
git commit -m "refactor(updater): build the updater from NestJS modules"
```

---

### Task 5: Start-up and shutdown through Nest lifecycle hooks

`main.ts` stops wiring anything by hand: `JobRunner` marks interrupted jobs on init, `SchedulerService` starts on bootstrap and stops on destroy.

**Files:**
- Modify: `updater/src/jobs/job-runner.ts`, `updater/src/scheduler/scheduler.service.ts`, `updater/src/main.ts`
- Create: `updater/src/lifecycle.test.ts`

**Interfaces:**
- Consumes: `testModule`, `TestOptions` (Task 4), `JobStore`, `JobRunner`, `SchedulerService`, `openDatabase`.
- Produces:
  - `JobRunner implements OnModuleInit`: `onModuleInit(): void` — `markInterrupted(this.now().toISOString())`, warn line when > 0. Comment: runs before any `onApplicationBootstrap`, so the scheduler's first check is never marked interrupted.
  - `SchedulerService implements OnApplicationBootstrap, OnModuleDestroy`: `onApplicationBootstrap()` → `start()`; `onModuleDestroy()` → `stop()`.
  - `main.ts` final: env check, `NestFactory.create(AppModule.forRoot(env), { logger: ["error", "warn"] })`, `listen`, listening log, `process.on("SIGTERM", () => void app.close().then(() => process.exit(0)))`.

- [ ] **Step 1: Write the failing lifecycle test** in `src/lifecycle.test.ts`

```ts
const NOW = new Date("2026-10-24T10:00:00.000Z");

test("start-up marks interrupted jobs before the scheduler's first check; close stops the scheduler", async () => {
  const database = openDatabase(":memory:");
  const old = new JobStore(database).createJob({ kind: "update", user: null, steps: [], startedAt: "2026-10-24T09:00:00.000Z" });
  const root = await tempDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const moduleRef = await testModule({ database, now: () => NOW, env: { root, configPath: join(root, "config.yml") } });
  const app = moduleRef.createNestApplication({ logger: false });

  await app.init();
  const jobs = moduleRef.get(JobStore);
  expect(jobs.job(old.id)).toMatchObject({ status: "interrupted", endedAt: NOW.toISOString() });
  expect(warn).toHaveBeenCalledWith("1 tâche(s) marquée(s) interrompue(s)");
  await moduleRef.get(JobRunner).idle();
  expect(jobs.job(old.id + 1)).toMatchObject({ kind: "check", status: "success" });

  const stop = vi.spyOn(moduleRef.get(SchedulerService), "stop");
  await app.close();
  expect(stop).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
```

- [ ] **Step 2: Run it** — `bun --bun vitest run src/lifecycle.test.ts` → FAIL (old job still `running`).
- [ ] **Step 3: Add the hooks** to `JobRunner` and `SchedulerService` per the Interfaces block.
- [ ] **Step 4: Slim `main.ts`** to the final form above (no `app.get`, no explicit scheduler calls).
- [ ] **Step 5: Run** `bun run test`, `bun run typecheck`, root lint/format → all pass.
- [ ] **Step 6: Boot smoke under Bun** (fish, from `updater/`; empty root so no docker command runs):

```fish
set tmp (mktemp -d)
env UPDATER_TOKEN=t PORT=18089 UPDATER_ROOT=$tmp UPDATER_CONFIG=$tmp/config.yml UPDATER_DATA=$tmp/data bun src/main.ts &
```

Once `curl -s localhost:18089/health` answers:
- `curl -s localhost:18089/health` → `{"ok":true}`
- `curl -s -o /dev/null -w "%{http_code}" localhost:18089/stacks` → `401`
- `curl -s -H "authorization: Bearer t" localhost:18089/stacks` → `{"stacks":[],"lastCheck":"<ISO date>","configError":null,"runningJob":null}` (the start-up check ran)
- `curl -s -H "authorization: Bearer t" localhost:18089/jobs/1` → `kind` `"check"`, `status` `"success"`
- `kill -TERM $last_pid` → the process exits promptly (`ps -p $last_pid` finds nothing), no error printed
- `env -u UPDATER_TOKEN bun src/main.ts; echo $status` → prints `UPDATER_TOKEN est requis`, then `1`

- [ ] **Step 7: Commit**

```bash
git add -A updater/src
git commit -m "refactor(updater): start-up and shutdown through Nest lifecycle hooks"
```
