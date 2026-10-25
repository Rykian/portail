# Per-Image Updates, Download Progress and Job Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner see and update the images of a stack one by one (pull-style stacks), follow each download with a progress bar, roll back a single image, and queue jobs instead of being refused while one runs.

**Architecture:** Shared Zod schemas first, then the updater bottom-up: a FIFO `JobRunner` that also relays throttled progress events; an `ImagePuller` over the Docker Engine socket (CLI fallback when credentials need a helper); per-service rollback points in a new table; `StackUpdater`/`PullStrategy` driven by an explicit selection; `UpdateService` validating selections, pinning the confirmed target and refusing rollbacks on busy stacks. Then the portal: pure view helpers, expandable stack rows with checkboxes, progress and per-image rollback, buttons that queue.

**Tech Stack:** Bun 1.4.4, NestJS 12.2, `bun:sqlite`, vitest 5 (`bun --bun vitest run`), Zod 4, ts-pattern, remeda; Next.js 16.4 + React 19.3 + shadcn (base-ui), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-per-image-updates-design.md` (mockup: `docs/superpowers/specs/2026-10-25-per-image-updates-mockup.html`). Read both before any task.

## Global Constraints

- Code comments in English, user-facing text in French. Explicit `@Inject(...)` on every constructor parameter; pure functions stay functions; strategies stay behind `UpdateStrategy` (conventions of `2026-10-25-updater-modules-design.md`).
- Docker Compose stays the tool for `config`, `ps`, `up`; only image downloads move to the Engine API. Image tag/rm stay on the CLI.
- An existing `rollbacks` row of kind `pull`, `version` or `recipe` must still roll back after deploy.
- A selection never pulls or recreates an unselected service.
- Progress events: never written to `job_logs`; at most one per image every 250 ms (state changes always sent).
- Every existing test keeps passing, adapted only where behaviour intentionally changes (409 busy → queued, whole-stack pull update → selectable services only).
- Verification after every task: `bun run typecheck` and `bun run test` in the touched app(s) (`apps/updater`, `apps/portail`, `packages/shared` has no tests of its own); from the repo root `bun run lint` and `bun run format:check`.
- Commit at the end of each task only if your human partner authorised commits for this execution (otherwise skip the commit step), on the branch the executor set up, message style `feat(updater): …` / `feat(portail): …` / `feat(shared): …`.

## Review Focus

1. **A check queued between confirmation and run changes the target** (new major for a variable stack, newer image for a floating one): the update must fail with the "cible a changé" message, never apply the new target. → Task 6, `update.service.test.ts` "a target changed by a check queued in between fails the step".
2. **An old `pull` row from the deployed DB** (`{"stack":"immich","to":"v1.140","major":false,"running":true,"data":{"kind":"pull","services":[…]}}`) must become per-service points at start-up and roll back image by image. → Task 4, `rollback.store.test.ts` "migrates a legacy pull row into per-service points".
3. **Two updates of the same stack queued back to back** (`server`, then `server` + `machine-learning`): the second updates only what is still out of date, and a version stack queued twice ends in success, not in `notNewerMessage`. → Task 6, "a second queued update of a done stack succeeds with nothing left to do".
4. **The SSE stream of a queued job** opened before it starts (portal reload while queued) must stay open, then replay logs/steps/progress once it runs. → Task 2, `job-runner.test.ts` "following a queued job waits for it to run".
5. **A registry whose credentials live in a `credsStore`/`credHelpers`** must still pull (through `docker pull`, without progress). → Task 3, `engine.test.ts` "falls back to the CLI when the registry uses a credential helper".

---

## File map

```
packages/shared/updater-api.ts            schemas: queued status, progress event, selection body, rollback body, pending jobs, per-service rollbacks
apps/updater/src/
  common/errors.ts                        + ConflictError (409)
  error.filter.ts                         BusyError → ConflictError
  jobs/job-runner.ts                      FIFO queue, targets, progress relay (throttled, replayed)
  jobs/job.store.ts                       createJob(status), markStarted, markInterrupted(queued too)
  docker/docker.ts                        ComposeService gains pullPolicy, platform
  docker/docker-cli.ts                    parse pull_policy/platform; pullImage CLI fallback
  docker/engine.ts (new)                  ImagePuller, IMAGE_PULLER, createEnginePuller, registryAuth, PullTracker
  docker/docker.module.ts                 provides IMAGE_PULLER
  database/database.ts                    + rollback_points table
  stacks/rollback.store.ts                stack-level (version/recipe) + per-service pull points, legacy migration
  stacks/stack-context.ts                 + selection, progress
  strategies/pull.strategy.ts             prepare/restore per selected service
  strategies/strategies.ts                selectableServices(), selectionMajor()
  update/stack-updater.ts                 pulls through ImagePuller, up --no-deps, per-service rollback
  update/update.service.ts                selection validation, pinned targets, rollback conflict, nothing-left
  update/target.ts (new)                  PinnedTarget, pinTarget, staleReason (pure)
  update/update.controller.ts             bodies
  detection/detection.service.ts          selectable, serviceRollbacks, pendingJobs
  scheduler/scheduler.service.ts          skip when running or queued
  test/fakes.ts                           FakeImagePuller
apps/portail/
  lib/updates-view.ts                     serviceLine, stackJobState, lockedServices, progressLabel
  components/updates/job-panel.tsx        queued label, progress in JobLog
  components/updates/stack-services.tsx   (new) expanded service lines
  components/updates/stacks-table.tsx     expand/collapse, row buttons
  components/updates/stacks-cards.tsx     same in cards
  components/updates/confirm-dialog.tsx   per-image rollback
  components/updates/updates-page.tsx     no global disable, selection state, follows running job progress
  e2e/fake-updater.mts, e2e/updates.spec.ts
```

---

### Task 1: Shared API schemas

**Files:**
- Modify: `packages/shared/updater-api.ts`
- Modify (compile fixes only): `apps/updater/src/**` and `apps/portail/**` where the new required fields break object literals (fakes, test fixtures, `e2e/fake-updater.mts` — give the new fields their empty values)

**Interfaces:**
- Produces (exact names, used by every later task):
  - `jobStatusSchema = z.enum(["queued", "running", "success", "failed", "interrupted"])`
  - `jobStepSchema` gains `services: z.array(z.string()).optional()` (targeted services of a selection; absent on old rows)
  - `imageProgressSchema = z.object({ stack: z.string(), service: z.string(), image: z.string(), downloaded: z.number(), total: z.number(), state: z.enum(["downloading", "done", "up-to-date"]) })`, type `ImageProgress`
  - `jobEventSchema` gains `z.object({ type: z.literal("progress"), progress: imageProgressSchema })`
  - `serviceRollbackSchema = z.object({ service: z.string(), to: z.string(), major: z.boolean() })`
  - `stackStatusSchema` gains `selectable: z.boolean()` and `serviceRollbacks: z.array(serviceRollbackSchema)`
  - `jobTargetSchema = z.object({ stack: z.string(), services: z.array(z.string()).nullable() })` (null = whole stack), type `JobTarget`
  - `pendingJobSchema = z.object({ id: z.number(), kind: jobKindSchema, status: z.enum(["queued", "running"]), targets: z.array(jobTargetSchema) })`, type `PendingJob`
  - `stacksResponseSchema` gains `pendingJobs: z.array(pendingJobSchema)` (running first, then queue order); `runningJob` stays
  - `updateBodySchema` gains `services: z.array(z.string()).optional()` (still `.strict()`)
  - `rollbackBodySchema = z.object({ service: z.string().optional() }).strict()`, type `RollbackBody`

- [ ] **Step 1:** Edit the schemas as listed. `stackStatusSchema.serviceRollbacks` is required: the updater always sends it (Task 6). Portal parses the updater's output, so both sides change in this task.
- [ ] **Step 2:** Run `bun run typecheck` at the repo root. Fix every object literal the new required fields break (`selectable: false, serviceRollbacks: []`, `pendingJobs: []`), and add the `"queued"` branch to every `match(status)…exhaustive()` on `JobStatus` (portal `statusLabel`: `"en attente"`). Nothing else.
- [ ] **Step 3:** Run `bun run test` at the repo root. Expected: all pass.
- [ ] **Step 4:** Commit `feat(shared): schemas for selections, progress and the job queue`.

---

### Task 2: Job queue and progress relay (Opus)

**Files:**
- Modify: `apps/updater/src/jobs/job-runner.ts`, `apps/updater/src/jobs/job.store.ts`, `apps/updater/src/common/errors.ts`, `apps/updater/src/error.filter.ts`, `apps/updater/src/scheduler/scheduler.service.ts`
- Test: `apps/updater/src/jobs/job-runner.test.ts`, `apps/updater/src/jobs/job.store.test.ts`, `apps/updater/src/scheduler/scheduler.service.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces:
  - `class ConflictError extends Error` in `common/errors.ts` (name `"ConflictError"`), mapped to 409 by `ErrorFilter`. `BusyError` is deleted.
  - `JobRunner.start(input: { kind: JobKind; user: string | null; steps: JobStep[]; targets: JobTarget[] }, work): Job` — never throws for busy; returns the job with status `"queued"` or `"running"`.
  - `JobContext = { id: number; log: LogSink; setSteps(steps: JobStep[]): void; progress(p: ImageProgress): void }`
  - `JobRunner.running(): number | null` (unchanged), `JobRunner.pending(): PendingJob[]`, `JobRunner.busy(): boolean` (running or queued), `JobRunner.idle()` resolves when nothing runs and the queue is empty.
  - `JobStore.createJob(input & { status: "queued" | "running" })`, `JobStore.markStarted(id: number, startedAt: string)` (sets `status='running'`, `started_at`), `markInterrupted` also matches `status = 'queued'`.

- [ ] **Step 1: Write the failing tests** in `job-runner.test.ts` (replace the BusyError test):
  - `"a second start while running is queued, then runs after the first"`: start A (gated), start B → `store.job(B.id)?.status === "queued"`, `runner.pending()` equals `[{ id: A.id, status: "running", … }, { id: B.id, status: "queued", … }]`; release A, `await runner.idle()` → both `"success"`, B's work ran after A's ended (record order).
  - `"queued jobs run in FIFO order"`: A gated, B and C queued; order of work calls is `[A, B, C]`.
  - `"a queued job's startedAt is set when it starts"`: clock returns `t1` at queue time, `t2` when it starts → `store.job(B.id)?.startedAt === t2`.
  - `"following a queued job waits for it to run"`: B queued, `collect(runner.events(B.id)!)` started before A ends; B logs `"x"` → collected `[{type:"log",line:"x"}, {type:"end",status:"success"}]` (no early `end` with `"queued"`).
  - `"progress is relayed, throttled, not logged and replayed to late followers"`: fake clock; work calls `progress` 10 times for one image within 100 ms with state `"downloading"`, then once `"done"` → a follower subscribed from the start receives the first `downloading`, then `done` (2 events); `store.jobLog(id)` contains no progress; a follower subscribing after the last progress but before `end` receives the latest progress of each image (one per image) in its replay, after steps.
  - `"idle waits for the queue to drain"`.
  - In `job.store.test.ts`: `"markInterrupted marks queued and running jobs"`.
  - In `scheduler.service.test.ts`: `"the scheduled check skips while a job is queued"` (uses `busy()`).
- [ ] **Step 2:** Run `cd apps/updater && bun --bun vitest run src/jobs src/scheduler`. Expected: FAIL.
- [ ] **Step 3: Implement.** `JobRunner` keeps `current: Running | null` and `queue: { running: Running; work }[]`; `start` creates the row (`queued` if `current` or queue non-empty, else `running`), stores `targets` in memory on `Running`; when a job ends, the next queued one is `markStarted` with `now()` and run. `follow()` treats a job that is `current` or in the queue as live (subscribe; no `end` pushed); for a live job the replay is log lines, steps, then the latest progress per `stack/service`. Throttle in `run`'s `progress`: keep `lastSent` per `stack/service`; emit if state changed or `now() - lastSent >= 250 ms`; always remember the latest value for the replay. Progress is cleared when the job ends. `ErrorFilter` maps `ConflictError` → 409. Scheduler uses `this.jobs.busy()`.
- [ ] **Step 4:** Run `bun --bun vitest run` (whole updater) and `bun run typecheck`. Callers of `start` gain `targets` (detection check: `[]`; update/rollback/update-all: one target per stack, `services: null` for now — Task 6 fills selections). Tests asserting 409 busy now assert a queued job. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updater): queue jobs instead of refusing them, relay download progress`.

---

### Task 3: Image downloads through the Engine API

**Files:**
- Create: `apps/updater/src/docker/engine.ts`, `apps/updater/src/docker/engine.test.ts`
- Modify: `apps/updater/src/docker/docker.ts`, `apps/updater/src/docker/docker-cli.ts` (+ test), `apps/updater/src/docker/docker.module.ts`, `apps/updater/src/test/fakes.ts`, `apps/updater/src/test/module.ts`

**Interfaces:**
- Produces:
  - `ComposeService` gains `pullPolicy: string | null` and `platform: string | null` (from `compose config --format json`, `pull_policy` / `platform`).
  - `type PullResult = "downloaded" | "up-to-date"`
  - `interface ImagePuller { pull(image: string, platform: string | null, onProgress: (downloaded: number, total: number) => void, log: LogSink): Promise<PullResult> }`, token `IMAGE_PULLER = Symbol("IMAGE_PULLER")`
  - `class PullTracker { update(event: unknown): void; downloaded(): number; total(): number; upToDate(): boolean; error(): string | null }` (pure, exported for tests)
  - `registryAuth(config: DockerConfig, registry: string): { kind: "anonymous" } | { kind: "header"; value: string } | { kind: "helper" }` and `type DockerConfig = { auths?: Record<string, { auth?: string; identitytoken?: string }>; credsStore?: string; credHelpers?: Record<string, string> }`
  - `createEnginePuller(options: { socket: string; dockerConfigPath: string; cliPull: (image: string, log: LogSink) => Promise<number> }): ImagePuller`
  - `FakeImagePuller` in `test/fakes.ts`: `calls: { image: string; platform: string | null }[]`, `results: Map<string, PullResult | Error>` (default `"downloaded"`), `progressSteps: Map<string, [number, number][]>` reported in order before resolving.

- [ ] **Step 1: Write the failing tests** in `engine.test.ts`:
  - `PullTracker`: `"counts only Downloading bytes"` — events for layers `a` (`Downloading` 50/100), `a` (`Extracting` 80/100), `b` (`Already exists`, no total), `c` (`Downloading` 10/40) → `downloaded() === 60`, `total() === 140` (`Extracting` ignored; a layer with no known total counts 0/0). Then `a` `Download complete` → `downloaded() === 110` (`Download complete`/`Pull complete` set a layer to its known total).
  - `"detects up to date"`: `{status: "Status: Image is up to date for nginx:latest"}` → `upToDate() === true`.
  - `"reports the stream error"`: `{error: "manifest unknown"}` → `error() === "manifest unknown"`.
  - `registryAuth`: `"anonymous without config entry"`, `"header from auths.auth"` (decoded `user:pass` → base64 JSON `{"username","password","serveraddress"}`), `"helper when credHelpers names the registry"`, `"helper when credsStore is set and auths has no inline auth"`. Docker Hub is looked up as `https://index.docker.io/v1/`.
  - `createEnginePuller` against a `Bun.serve({ unix: <tmp socket> })` fake: `"streams progress and returns downloaded"` (asserts query `fromImage=ghcr.io/immich-app/immich-server&tag=release` and `platform` when given), `"fails with the stream error"` (rejects with `Error` whose message contains `manifest unknown`), `"falls back to the CLI when the registry uses a credential helper"` (cliPull called, no socket request, `onProgress` never called, result `"downloaded"`; non-zero exit rejects with `docker pull <image> a échoué (code N)`).
  - In `docker-cli.test.ts`: `"parseComposeConfig reads pull_policy and platform"`.
- [ ] **Step 2:** Run `bun --bun vitest run src/docker`. Expected: FAIL.
- [ ] **Step 3: Implement** in `engine.ts`. Split `image` with `parseImageRef` logic (registry + path for `fromImage`, `tag` or digest for `tag`). `fetch("http://docker/images/create?…", { method: "POST", unix: socket, headers })`, read NDJSON lines, feed `PullTracker`, call `onProgress` on each `Downloading`/completion event (throttling is the runner's job). Docker config read once per pull from `dockerConfigPath` (`$HOME/.docker/config.json`; missing file = `{}`). Add `pullImage` CLI streaming helper in `docker-cli.ts` (`docker pull <image>`). `DockerModule` provides `IMAGE_PULLER` with socket `/var/run/docker.sock`; `test/module.ts` overrides it with `FakeImagePuller` (new `TestOptions.puller`).
- [ ] **Step 4:** Run `bun --bun vitest run` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updater): download images through the Engine API with progress`.

---

### Task 4: Per-service rollback points (Opus)

**Files:**
- Modify: `apps/updater/src/database/database.ts` (+ `database.test.ts`), `apps/updater/src/stacks/rollback.store.ts`
- Create: `apps/updater/src/stacks/rollback.store.test.ts`

**Interfaces:**
- Produces:
  - Table `rollback_points (stack TEXT NOT NULL, service TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (stack, service))`.
  - `type PullPoint = { stack: string; service: string; image: string; to: string; major: boolean; running: boolean }`
  - `RollbackStore`: `save/get/delete(stack)` (stack-level, unchanged signatures), `points(stack): PullPoint[]` (ordered by service), `savePoint(point)`, `deletePoint(stack, service)`, `migrateLegacy(): number` (returns rows migrated).
  - `RollbackState.data` keeps its `pull` variant in this task so the build stays green; Task 5 removes it once `PullStrategy` writes points.

- [ ] **Step 1: Write the failing tests** in `rollback.store.test.ts`:
  - `"a point per service, replaced by the next update of that service"`.
  - `"points of other services are left alone"`.
  - `"migrates a legacy pull row into per-service points"`: insert raw `rollbacks` row `{"stack":"immich","to":"v1.140","major":true,"running":true,"data":{"kind":"pull","services":[{"service":"server","image":"ghcr.io/immich-app/immich-server:release"},{"service":"machine-learning","image":"ghcr.io/immich-app/immich-machine-learning:release"}]}}` → `migrateLegacy() === 1`, `get("immich") === null`, `points("immich")` has two points with `to: "v1.140"`, `major: true`, `running: true`; a second `migrateLegacy()` returns 0.
  - `"version and recipe rows are not migrated"`.
  - In `database.test.ts`: the table list includes `rollback_points`.
- [ ] **Step 2:** Run `bun --bun vitest run src/stacks src/database`. Expected: FAIL.
- [ ] **Step 3: Implement.** `migrateLegacy` runs in one transaction; `RollbackStore` implements `OnModuleInit` calling it (logs `console.warn(\`${n} retour(s) arrière migré(s) par service\`)` when n > 0). No change outside the store and the schema: nothing reads the points yet.
- [ ] **Step 4:** Run `bun --bun vitest run` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updater): store pull rollbacks per service`.

---

### Task 5: Selective pull, per-service rollback in StackUpdater (Opus)

**Files:**
- Modify: `apps/updater/src/stacks/stack-context.ts`, `apps/updater/src/strategies/strategy.ts`, `apps/updater/src/strategies/pull.strategy.ts`, `apps/updater/src/strategies/strategies.ts` (+ test), `apps/updater/src/update/stack-updater.ts`, `apps/updater/src/update/update.module.ts` (inject `IMAGE_PULLER`)
- Test: `apps/updater/src/update/stack-updater.test.ts`, `apps/updater/src/strategies/strategies.test.ts`

**Interfaces:**
- Consumes: `ImagePuller`/`FakeImagePuller` (Task 3), `PullPoint`/`RollbackStore` (Task 4), `ImageProgress` (Task 1).
- Produces:
  - `StackContext` gains `selection: string[] | null` (pull-style: the targeted service names; null for version/recipe) and `progress: (p: ImageProgress) => void`.
  - `selectableServices(status: StackStatus, config: StackConfig): string[]` (exported function in `strategies.ts`): empty unless `status.mode === "pull"` or (`config.version` and `status.available === null`); otherwise names of services with `kind === "floating" && update`.
  - `selectionMajor(status: StackStatus, selection: string[]): boolean`: some selected service has non-null `current`/`available` and `isMajorBump(current, available)`.
  - `PullStrategy.prepare(ctx, before): Promise<Plan<"pull">>` where the pull plan carries `points: PullPoint[]` instead of a stack-level rollback; `Plan` becomes a union `{ kind: "pull"; points: PullPoint[]; apply } | { kind: "version" | "recipe"; rollbackTo; rollback; apply }` (exact shape is the implementer's, keep `UpdateStrategy` the single interface).
  - `StackUpdater.update(ctx): Promise<"success" | "failed">` (same signature), `StackUpdater.rollback(ctx, service: string | null)`.
  - `RollbackState.data` loses its `pull` variant (pull rollbacks are points only); `Strategies.restore` handles version/recipe, `PullStrategy.restore(ctx, points: PullPoint[])` handles points.

- [ ] **Step 1: Write the failing tests** in `stack-updater.test.ts` (fixtures: stack `immich` with services `server` and `machine-learning` floating, `redis` literal, `postgres` pinned; all running):
  - `"a selection tags, pulls and recreates only the selected services"`: `selection: ["server"]` → `tagCalls` only `server`; `puller.calls` only the server image; `composeCalls` contains `["up", "-d", "--no-deps", "server"]` and no `pull`; one point `immich/server`.
  - `"major and before follow the selection"`: config `beforeOnlyOnMajor: true, before: ["backup"]`; `server` v1→v2, `machine-learning` v1.1→v1.2, stack `major` computed from `machine-learning` = false; selecting `server` runs `backup` and stores `major: true` on its point.
  - `"progress is reported per image"`: `FakeImagePuller.progressSteps` for server `[[10, 100], [100, 100]]` → `ctx.progress` receives `downloading 10/100`, `downloading 100/100`, then `done`; `up-to-date` result reports state `"up-to-date"`. One log line at start (`== téléchargement de <image>`) and one at end (`<image> téléchargée` / `<image> déjà à jour`) per image.
  - `"version update pulls every image except pull_policy build/never, passes platform, ups the whole stack"`: `compose` calls contain `["up", "-d"]`, no `pull`.
  - `"a pull failure fails the update before up"`.
  - `"a stopped stack downloads and stays stopped"` (selection on stopped stack: no `up`).
  - `"rollback of one service retags it, ups it alone, checks the whole stack, drops its point"`: points `server`, `machine-learning` → `rollback(ctx, "server")` → `tagCalls` `updater-rollback/immich-server:latest → <server image>`, `compose` `["up", "-d", "--no-deps", "server"]`, `wait` called, `removeImageCalls` `["updater-rollback/immich-server:latest"]`, `points` only `machine-learning`.
  - `"rollback of all points ups only those that were running, in one up"`: `server` running:true, `machine-learning` running:false → one `["up", "-d", "--no-deps", "server"]`, both retagged, both points gone.
  - `"a point whose service left the compose file is skipped on rollback and dropped on the next update"`: rollback logs `machine-learning n'est plus dans la stack : ignoré`; next update of `server` removes the orphan point and its tag.
  - `"a version update replaces the pull points of the stack, and a pull update drops a version rollback"`.
  - `"rollbacks stored before the change still restore"`: raw legacy pull row migrated (Task 4) → `rollback(ctx, null)` restores both; raw `version` row restores as today.
  - In `strategies.test.ts`: `selectableServices` cases (pull stack; version stack with `available === null`; version stack with target → `[]`; literal/pinned/no-update excluded); `selectionMajor`.
- [ ] **Step 2:** Run `bun --bun vitest run src/update/stack-updater.test.ts src/strategies`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pull step: services to download = `selection` for pull-style, all compose services with an image for version/recipe (resolved after `apply`); skip `pullPolicy` `build`/`never`. For each image in order: log, `puller.pull(image, platform, (d, t) => ctx.progress({…, state: "downloading"}), log)`, then progress `done`/`up-to-date`, log. `up`: pull-style `["up", "-d", "--no-deps", ...selection]`, version/recipe `["up", "-d"]`. Health check of the whole stack as today. `PullStrategy.prepare` tags only running selected services (digest refs still skipped), builds points `{ to: service.current ?? service.newImageDate ?? "l'image précédente", major: isMajorBump-per-service, running: isStackUp(before) }`. Saving: pull update → delete stack-level rollback, save each point, drop orphan points (service not in compose) with their tags; version/recipe → delete all points (+ tags), save stack-level. `before` commands rule uses `selectionMajor` when `selection !== null`. Version/recipe rollbacks unchanged (`up -d --pull missing`).
- [ ] **Step 4:** Run `bun --bun vitest run` and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updater): update and roll back pull-style stacks image by image`.

---

### Task 6: UpdateService, API and status (Opus)

**Files:**
- Create: `apps/updater/src/update/target.ts`, `apps/updater/src/update/target.test.ts`
- Modify: `apps/updater/src/update/update.service.ts` (+ test), `apps/updater/src/update/update.controller.ts`, `apps/updater/src/update/update-all.ts` (+ test), `apps/updater/src/detection/detection.service.ts` (+ test), `apps/updater/src/app.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `type PinnedTarget = { stack: string; available: string | null; services: { name: string; available: string | null; newImageDate: string | null }[]; confirmed: boolean }`
  - `pinTarget(status: StackStatus, selection: string[] | null, confirmed: boolean): PinnedTarget`
  - `staleReason(pinned: PinnedTarget, fresh: StackStatus, freshNeedsConfirm: boolean): string | null` — returns `la cible a changé depuis la demande (<old> → <new>) : relancer la mise à jour` when the stack `available` (version/recipe) or a still-out-of-date pinned service's `available ?? newImageDate` differs; `une confirmation est maintenant nécessaire : relancer la mise à jour` when `freshNeedsConfirm && !pinned.confirmed`; otherwise null.
  - `UpdateService.update(name, body: UpdateBody, user)`, `UpdateService.rollback(name, body: RollbackBody, user)`, `UpdateService.updateAll(user)` — all return `{ jobId }` / `needsConfirm` as today.
  - `DetectionService.stacks()` returns `selectable`, `serviceRollbacks` (from `RollbackStore.points`, mapped to `{ service, to, major }`), `rollback` (stack-level row, or — when only points exist — `{ to: "<n> image(s)", major: any point major }` so "something can be rolled back" keeps holding), `pendingJobs: jobs.pending()`.

- [ ] **Step 1: Write the failing tests:**
  - `target.test.ts`: `"same target → null"`, `"new variable target → changed message"`, `"newer floating image → changed message"`, `"a pinned service no longer out of date is not a change"`, `"needs a confirmation that was not given"`.
  - `update.service.test.ts`:
    - `"services on a stack that does not allow a selection → 400"` (`Mise à jour par image impossible pour <stack>`), `"empty selection → 400"`, `"unknown or not selectable service → 400"` (`Service non sélectionnable : <name>`).
    - `"without services, a pull stack updates every selectable service"` (step `services` lists them).
    - `"needsConfirm of a selection is computed on the selection"`: stack `needsConfirm` true only because of an unselected major → selecting the minor one starts a job directly.
    - `"a target changed by a check queued in between fails the step"`: gate a first job, queue a confirmed update of `mealie` v3.4.0→v3.5.0, change the stored status to available `v4.0.0`, release → step `failed`, log contains `la cible a changé`, env file untouched.
    - `"a second queued update of a done stack succeeds with nothing left to do"` (version stack queued twice → second step `success`, log `rien à faire : déjà à jour`, `prepare` not reached).
    - `"rollback while the stack has a queued or running job → 409"` (`ConflictError`, message `Une tâche est déjà prévue pour <stack>, attends qu'elle se termine`), including a queued update-all that contains the stack; a stack not concerned can be rolled back.
    - `"rollback of one service needs its point"` (400 `Aucun retour arrière disponible pour <stack>/<service>`), `"rollback without service takes every point"`.
    - `"update-all pins the planned targets"`.
  - `app.test.ts`: `"POST update accepts services, POST rollback accepts service, both reject unknown keys"`; `"a request while a job runs is queued (200 with jobId)"` replaces the 409 test.
  - `detection.service.test.ts`: `"stacks() exposes selectable, serviceRollbacks and pendingJobs"`.
- [ ] **Step 2:** Run `bun --bun vitest run src/update src/detection src/app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `update()`: resolve `selection = body.services ?? (selectable non-empty ? selectable : null)` and validate; `needsConfirm` for a selection = `config.confirm || selectionMajor(...)`; confirmation response `from/to` for a selection = the single service's `current/available` when one service, else `null` / the joined names. Step: `{ stack, status: "pending", from, to, services: selection ?? undefined }`; targets `[{ stack, services: selection }]`. `runUpdate(name, log, progress, pinned)` re-reads, returns success with `rien à faire : déjà à jour` when nothing pinned is still `update` (stack `update === false` for version/recipe), fails with `staleReason` when non-null, else builds ctx with `selection` (pinned services still out of date). `rollback()`: `ConflictError` when any `pendingJobs` target names the stack. `updateAll` pins targets at queue time; pull-style stacks in it get `selection = selectableServices`. Controller parses `rollbackBodySchema`.
- [ ] **Step 4:** Run `bun --bun vitest run` and `bun run typecheck`, then `bun run lint && bun run format:check` at the root. Expected: PASS.
- [ ] **Step 5:** Commit `feat(updater): selections, pinned targets and per-image rollback in the API`.

---

### Task 7: Portal — expandable stacks, selection, progress, queue

**Files:**
- Modify: `apps/portail/lib/updates-view.ts` (+ `updates-view.test.ts`), `apps/portail/components/updates/job-panel.tsx`, `stacks-table.tsx`, `stacks-cards.tsx`, `confirm-dialog.tsx`, `updates-page.tsx`, `history.tsx` (step services)
- Create: `apps/portail/components/updates/stack-services.tsx`

Before writing components, read the relevant guide in `apps/portail/node_modules/next/dist/docs/` (see `apps/portail/AGENTS.md`).

**Interfaces:**
- Consumes: Task 1 types.
- Produces (pure, in `updates-view.ts`):
  - `serviceKindLabel(kind: ServiceKind): string` — `floating` → `"flottante"`, `variable` → `"variable"`, `literal` → `"version en dur"`, `pinned` → `"figée"`.
  - `serviceChange(service: ServiceStatus): string | null` — `"<current> → <available>"`, or `"image du <dd/mm/yyyy>"` from `newImageDate`, or null.
  - `stackJobState(stack: string, pending: PendingJob[]): "running" | "queued" | null`
  - `lockedServices(stack: StackStatus, pending: PendingJob[]): Set<string>` — services targeted by a pending job of this stack (`services: null` → every selectable one).
  - `progressLabel(p: ImageProgress): string` — `"27 % · 0,4/1,5 Go"` (fr-FR, Go/Mo with one decimal; total 0 → `"…"`), `"téléchargée"`, `"déjà à jour"`.
  - `JobLog` gains `progress: Record<string, ImageProgress>` keyed `"<stack>/<service>"`.

- [ ] **Step 1: Write the failing tests** in `updates-view.test.ts` for each function above, with the mockup's values (`progressLabel({downloaded: 0.4e9, total: 1.5e9, …})` → `"27 % · 0,4/1,5 Go"`; `serviceChange` with `newImageDate: "2026-10-22T…"` → `"image du 22/10/2026"`; `lockedServices` with a running job `{ stack: "immich", services: ["server"] }` → `{"server"}`, with `services: null` → every selectable service).
- [ ] **Step 2:** Run `cd apps/portail && bun --bun vitest run lib/updates-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the helpers**, then the components, following the mockup:
  - Each stack row (table and cards) gets a toggle button (`aria-expanded`, `aria-label="Détails de <stack>"`), collapsed by default; expanded lines from `StackServices`: for selectable services a native `<input type="checkbox">` labelled with the service name (checked by default, disabled when locked), tag badge (`parseImageRef`-like tag shown from `image`; digest → `@sha256`), `serviceChange` or `serviceKindLabel` muted for literal/pinned, error in `text-destructive`; right side: progress bar (`role="progressbar"`, `aria-valuenow`) + `progressLabel` while the followed running job reports it, else « Revenir à <to> » when the service has a point.
  - Stack row buttons: selectable stack → « Tout mettre à jour » (`aria-label="Tout mettre à jour <stack>"`) and « Mettre à jour la sélection (n) » (disabled when n = 0); other stacks → existing single button. « Tout remettre en arrière » when `stack.rollback`. A pending job on the stack shows « en attente » / « en cours » next to the name; rollback buttons disabled then; update buttons stay enabled for unlocked services.
  - Selection state lives in `UpdatesPage` (`Record<stack, Set<service>>`, default = selectable minus locked).
  - Page-level button renamed « Mettre à jour toutes les stacks » (avoids two « Tout mettre à jour » with the row buttons). Buttons are disabled only while a request is in flight (`pending`), not because a job runs.
  - Progress: `UpdatesPage` follows `data.runningJob` with `useJobEvents` (separate from the panel, which shows the job the user last started, labelled « en attente » while queued) and reloads `stacks` on its `end`, so the next queued job is picked up.
  - Confirmations: update with `services` in the body (and `confirm: true` on confirm); per-image rollback dialog « Revenir à <to> ? » / « <service> de <stack> reprendra son image précédente. » with `MIGRATION_WARNING` when that point's `major` (or the stack's `confirm`/`recipe`); « Tout remettre en arrière » uses the stack-level warning as today.
  - Job panel and history: a step with `services` shows `<stack> (<services joined by ", ">)`.
- [ ] **Step 4:** Run `bun --bun vitest run` and `bun run typecheck` in `apps/portail`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(portail): expandable stacks, image selection, download progress and queued jobs`.

---

### Task 8: Portal e2e

**Files:**
- Modify: `apps/portail/e2e/fake-updater.mts`, `apps/portail/e2e/updates.spec.ts`

**Interfaces:**
- Consumes: the API of Tasks 1 and 6, the UI of Task 7.

- [ ] **Step 1:** Extend the fake: an `immich` pull stack (`selectable: true`; `server` floating v1.140→v1.141, `machine-learning` floating new image 2026-10-22, `redis` literal `7.4`, `postgres` pinned), `serviceRollbacks` for `server` after an update; `POST /stacks/immich/update` records the body (exposed at `GET /__last-body`) and answers `{ jobId: 4 }`; `GET /jobs/4/events` streams progress events for both images then `end`; `POST /stacks/immich/rollback` records the body. Keep every existing route.
- [ ] **Step 2: Write the tests** in `updates.spec.ts`:
  - `"expanding immich lists its images with plain labels"`: « version en dur », « figée », « v1.140 → v1.141 », « image du 22/10/2026 »; only two checkboxes, both checked.
  - `"unchecking an image updates the selection only"`: uncheck machine-learning → button « Mettre à jour la sélection (1) » → `__last-body` equals `{ services: ["server"] }`.
  - `"download progress shows per image"`: a `progressbar` for machine-learning appears, then « téléchargée ».
  - `"rolling back one image sends its service"`: « Revenir à v1.140 » → confirm → body `{ service: "server" }`.
  - Adapt the existing test that clicks « Tout mettre à jour » to « Mettre à jour toutes les stacks ».
- [ ] **Step 3:** Run `bun run e2e` from the repo root. Expected: PASS.
- [ ] **Step 4:** Commit `test(e2e): per-image updates, progress and rollback`.

---

## After the last task

Manual check on CT 100 (your human partner): deploy, then on a real pull stack expand it, update one image, watch the bar, roll it back; queue two updates; confirm an existing rollback from before the deploy still works. If a stack's registry needs credentials, check the CLI fallback log lines appear.
