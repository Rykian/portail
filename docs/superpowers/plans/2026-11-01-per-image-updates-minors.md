# Per-Image Updates — Review Minors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight Minor findings of the final review of `feat/per-image-updates` (ledger: `.superpowers/sdd/2026-10-25-per-image-updates/progress.md`, lines `Final: minor (deferred)`).

**Architecture:** Small, independent fixes on the existing branch: four in the updater (pinned target, progress throttle, point pruning, update-all confirmation rule, download dedup), one in the portal (failed-job rollback and multi-service labels). No new modules; pure helpers where the rule needs a test.

**Tech Stack:** Bun 1.4.4, NestJS 12.2, `bun:sqlite`, vitest 5 (`bun --bun vitest run`), Zod 4, ts-pattern, remeda; Next.js 16.4 + React 19.3, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-per-image-updates-design.md` (unchanged; this plan argues from it and from the review findings quoted per task). Parent plan: `docs/superpowers/plans/2026-10-25-per-image-updates.md`.

## Global Constraints

- Everything in the parent plan's Global Constraints still holds (English comments, French UI text, explicit `@Inject`, a selection never pulls or recreates an unselected service, progress never in `job_logs`, at most one progress per image every 250 ms with state changes always sent).
- Base state: the Important fix of the final review (per-stack failure counter in `update.service.ts`, test "a queued update fails when an earlier job failed on the stack, keeping the rollback point") is in the working tree. It must keep passing.
- Verification after every task: `bun run typecheck` and `bun run test` in the touched app(s); from the repo root `bun run lint` and `bun run format:check`. Task 6 also runs `bun run e2e`.
- Commit at the end of each task only if your human partner authorised commits for this execution; message style `fix(updater): …` / `fix(portail): …`.

## Review Focus

1. **A queued version update whose re-check found an even newer version** must end in « rien à faire : déjà à jour », not in « la cible a changé ». → Task 1.
2. **The last download event inside a throttle window** must still reach the portal within 250 ms (no bar stuck below 100 % during extraction), and no timer may fire after the job ended. → Task 2.
3. **A point whose service still runs the old image but whose tag already resolves to the new one** (compose up failed after the pull) must not be pruned. → Task 3.
4. **The page-level update button** must never be enabled for a set the updater then refuses with « Aucune mise à jour à appliquer ». → Task 4.
5. **Rolling back from the failed-job panel** must only touch the services of the failed step, and must be disabled while the stack has a pending job. → Task 6.

---

### Task 1: A queued version update already reached by an earlier job is "nothing to do"

Finding: two queued jobs for mealie v3.4.0→v3.5.0; the first applies v3.5.0 and its re-check finds v3.6.0; the second sees `update: true`, `available` v3.6.0 ≠ pinned v3.5.0 and fails with « la cible a changé » although what was asked is applied.

**Files:**
- Modify: `apps/updater/src/update/target.ts`, `apps/updater/src/update/update.service.ts` (`runUpdate`)
- Test: `apps/updater/src/update/target.test.ts`, `apps/updater/src/update/update.service.test.ts`

**Interfaces:**
- Produces: `reached(pinned: PinnedTarget, fresh: StackStatus): boolean` in `target.ts` — true when `fresh.mode !== "pull"`, `pinned.available !== null`, `fresh.current !== null` and `compareVersions(fresh.current, pinned.available) >= 0` (`compareVersions` from `../docker/versions`).

- [ ] **Step 1: Write the failing tests.**
  - `target.test.ts`: `"a version stack whose current reaches the pinned target is reached"` (pinned available `v3.5.0`, fresh current `v3.5.0`, available `v3.6.0` → true); `"a version stack still below the target is not reached"` (current `v3.4.0` → false); `"a pull stack is never reached at stack level"` (mode `pull` → false).
  - `update.service.test.ts`: `"a second queued update reached by the first succeeds even when the re-check found a newer version"`: reuse `mealieStack()` + `MEALIE_CONFIG`, gate, queue `update("mealie", {}, null)` twice, make the first job's re-check report `v3.6.0` available (registry tags gain `v3.6.0` before release), release → second job `success`, its log contains `rien à faire : déjà à jour`, `.env` holds `VERSION=v3.5.0`.
- [ ] **Step 2:** `cd apps/updater && bun --bun vitest run src/update/target.test.ts src/update/update.service.test.ts`. Expected: FAIL (`reached` not exported; second job `failed`).
- [ ] **Step 3: Implement** `reached`; in `runUpdate`, the "nothing left" branch for `selection === null` becomes `!status.update || reached(pinned, status)`. It stays after the re-check-error check and before the failure-counter and `staleReason` checks.
- [ ] **Step 4:** Same command, then the whole updater suite and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `fix(updater): a queued update already reached by an earlier job has nothing left to do`.

---

### Task 2: Trailing flush for throttled progress

Finding: `progress` in `job-runner.ts` drops an event that lands within 250 ms of the last one sent and never sends it later, so the bar sits around 95 % during extraction.

**Files:**
- Modify: `apps/updater/src/jobs/job-runner.ts` (the `progress` closure in `run`, job end)
- Test: `apps/updater/src/jobs/job-runner.test.ts`

**Interfaces:**
- No signature change. `Running` gains a per-key pending timer (`Map<string, ReturnType<typeof setTimeout>>`).

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`; advance the runner's injected clock and the timers together, the same way the existing throttle test advances its clock):
  - `"a throttled progress is sent once the interval has passed"`: at t0 `downloading` 10/100 (sent), at t0+100 `downloading` 50/100 (throttled) → nothing more yet; advance to t0+250 → follower receives `downloading` 50/100. Exactly 2 progress events.
  - `"a newer throttled value replaces the pending one"`: t0 10, t0+100 50, t0+200 90 → at t0+250 one event with 90.
  - `"a state change cancels the pending flush"`: t0 10, t0+100 50 (pending), t0+150 `done` (sent at once) → at t0+250 nothing more; events are `[10, done]`.
  - `"no flush after the job ended"`: t0 10, t0+100 50, job ends at t0+120 → advancing past t0+250 sends nothing after `end`.
- [ ] **Step 2:** `bun --bun vitest run src/jobs/job-runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** On a throttled event, if no timer is pending for the key, schedule one for `PROGRESS_INTERVAL - (at - sentAt)` ms that sends the latest stored value for the key and records `sentAt`. A sent event (state change or interval passed) clears the key's pending timer. When the job ends, clear every pending timer with the progress map.
- [ ] **Step 4:** Whole updater suite and typecheck. Expected: PASS (the existing test "progress is relayed, throttled, not logged and replayed to late followers" still sees 2 events; if it now sees a flushed one, it was asserting the bug — rule on it in the ledger).
- [ ] **Step 5:** Commit `fix(updater): send the last throttled download progress`.

---

### Task 3: Pruning points — safe condition, and once at start-up

Findings: (a) `prunePoints` (detection.service.ts) deletes a point when its rollback tag is the running image, even when the service's own tag already resolves to the new image (compose up failed after the pull): the retag a rollback would do is lost. (b) Points migrated from a legacy pull row show « Revenir à <stack-level to> » on services that never changed until a check prunes them, and the start-up check only runs when the last check is older than 6 h.

**Files:**
- Modify: `apps/updater/src/detection/detection.service.ts`, `apps/updater/src/scheduler/scheduler.service.ts`
- Test: `apps/updater/src/detection/detection.service.test.ts`, `apps/updater/src/scheduler/scheduler.service.test.ts`

**Interfaces:**
- Produces: `DetectionService.pruneAllPoints(): Promise<void>` — loads the config, discovers the stacks, prunes each stack that has points; errors are logged with `console.warn`, never thrown.

- [ ] **Step 1: Write the failing tests:**
  - `detection.service.test.ts`: `"a point is kept when the service tag already resolves to the new image"`: point `immich/server`, rollback tag id `old`, running container imageId `old`, `docker.images` for the server image id `new` → after a check the point is still there and no `removeImage` of the tag. Existing pruning case (tag = running = service tag) still prunes.
  - `detection.service.test.ts`: `"pruneAllPoints drops the points of unchanged services without a check"`: two points, one whose tag/running/service image are the same id → after `pruneAllPoints()` only the other remains; no job created.
  - `scheduler.service.test.ts`: `"start-up prunes points when no check is due"`: last check 1 h ago → `pruneAllPoints` called once, no check started.
- [ ] **Step 2:** `bun --bun vitest run src/detection src/scheduler`. Expected: FAIL.
- [ ] **Step 3: Implement.** Prune only when the rollback tag id, the running container's imageId and `docker.image(<service image>)?.id` are all equal (service image from the stack's compose services). `pruneAllPoints` reuses `prunePoints`. The scheduler's `onApplicationBootstrap` calls `void this.detection.pruneAllPoints()` when it does not start a check (a check prunes anyway).
- [ ] **Step 4:** Whole updater suite and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `fix(updater): prune rollback points only when nothing is left to restore, and at start-up`.

---

### Task 4: A selectable stack's `needsConfirm` follows its selectable services

Finding: the portal's `updateAllCount` counts stacks with `!needsConfirm`, but the updater's update-all leaves out a pull-style stack whose selectable services need a confirmation (`config.confirm || selectionMajor(status, selectable)`). The stack-level `major` comes from the first updated service only, so `needsConfirm` can be false while a selectable service has a major bump: the button is enabled and the request answers 400 « Aucune mise à jour à appliquer ».

Ruling taken in this plan: fix the source, not the portal. For a stack with selectable services, the stored `needsConfirm` is exactly what updating all of them needs: `config.confirm || selectionMajor(status, selectableServices(status, config))`. Other stacks keep today's rule. The portal and `planUpdateAll` then agree without change.

**Files:**
- Modify: `apps/updater/src/detection/detection.service.ts` (`checkStack`, where `needsConfirm` and `selectable` are computed)
- Test: `apps/updater/src/detection/detection.service.test.ts`, `apps/updater/src/update/update.service.test.ts`

**Interfaces:**
- Consumes: `selectableServices`, `selectionMajor` from `strategies/strategies.ts`.
- Before implementing, read `strategies/strategies.ts:17` (its use of `status.needsConfirm`) and confirm it still means what it should with the new value; ledger a ruling if not.

- [ ] **Step 1: Write the failing tests:**
  - `detection.service.test.ts`: `"a selectable stack needs a confirmation when any selectable service has a major bump"`: pull stack, `machine-learning` 1.0→1.1 listed first, `server` 1.0→2.0 second → `major === false` (stack-level, unchanged), `needsConfirm === true`.
  - `update.service.test.ts`: `"update-all and the stored status agree on a selectable stack with a major service"`: that stack alone out of date → `stackStatuses()[0].needsConfirm === true` and `updateAll` throws `Aucune mise à jour à appliquer`.
- [ ] **Step 2:** `bun --bun vitest run src/detection src/update`. Expected: FAIL (`needsConfirm` false).
- [ ] **Step 3: Implement** in `checkStack`.
- [ ] **Step 4:** Whole updater suite, portal suite, typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `fix(updater): a selectable stack needs a confirmation when its selectable services do`.

---

### Task 5: Download an image shared by several services once

Finding: version/recipe updates download every compose service's image one by one (stack-updater.ts `pullAndStart`); `compose pull` deduplicated them.

**Files:**
- Modify: `apps/updater/src/update/stack-updater.ts` (`pullAndStart`)
- Test: `apps/updater/src/update/stack-updater.test.ts`

- [ ] **Step 1: Write the failing test** `"an image shared by two services is downloaded once"`: version stack with services `app` and `worker` both on `ghcr.io/acme/app:${APP_TAG}` (same platform) → `puller.calls` has the image once; one `== téléchargement de …` log line. Same image with a different `platform` → downloaded twice.
- [ ] **Step 2:** `bun --bun vitest run src/update/stack-updater.test.ts`. Expected: FAIL (2 calls).
- [ ] **Step 3: Implement** with remeda `uniqueBy(targets, (s) => \`${s.image}|${s.platform ?? ""}\`)` after the `isDownloaded` filter; progress for a shared image is reported under the first service that uses it.
- [ ] **Step 4:** Whole updater suite and typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `fix(updater): download an image shared by several services once`.

---

### Task 6: Portal — failed-job rollback and multi-service labels

Findings: (a) the failed-job panel's button rolls back every point of the stack (« Revenir à 2 image(s) ? »), also reverting services updated earlier, and is not disabled while the stack has a pending job (409). (b) History shows « ? → server, machine-learning » for a multi-service step; the stack-level rollback dialog title reads « Revenir à 2 image(s) ? »; the rollback-all step's `from` mirrors one service.

**Files:**
- Modify: `apps/portail/lib/updates-view.ts` (+ `updates-view.test.ts`), `apps/portail/components/updates/job-panel.tsx`, `apps/portail/components/updates/updates-page.tsx`, `apps/portail/components/updates/history.tsx`, `apps/portail/components/updates/confirm-dialog.tsx`, `apps/updater/src/update/update.service.ts` (`rollback`: step `from`), `apps/portail/e2e/*` if an existing assertion changes
- Test: `apps/portail/lib/updates-view.test.ts`, `apps/updater/src/update/update.service.test.ts`

**Interfaces:**
- Produces (pure, `updates-view.ts`):
  - `panelRollback(failed: JobStep | undefined, stacks: StackStatus[], pending: PendingJob[]): { stack: StackStatus; points: ServiceRollback[] | null; disabled: boolean } | null` — null when no failed step or its stack has no `rollback`. A step with `services`: `points` = the stack's `serviceRollbacks` for those services (null result when none has a point). A step without `services`: `points: null` (stack-level button as today). `disabled` = `stackJobState(stack.name, pending) !== null`.
  - `stepVersions(steps: JobStep[]): string` — moved from `history.tsx`'s `versions()`; a step with `services` contributes `stepTitle(step)` instead of `from → to`.
  - `stackRollbackTitle(stack: StackStatus): string` — `« Revenir aux images précédentes ? »` when the stack has `serviceRollbacks` and no stack-level row (its `rollback.to` is the `<n> image(s)` summary: test on `serviceRollbacks.length > 0`), else `` `Revenir à ${stack.rollback!.to} ?` ``.
- `JobPanel` gains `pendingJobs: PendingJob[]`; `onRollback: (stack: StackStatus, service?: string) => void` (the page's `rollback` already has this signature).
- The rollback `Confirmation` gains `title: string`; `confirm-dialog.tsx` renders it instead of `Revenir à {to} ?` (per-service: `Revenir à ${point.to} ?`, stack-level: `stackRollbackTitle(stack)`).

- [ ] **Step 1: Write the failing tests:**
  - `updates-view.test.ts`: `panelRollback` — failed step `{ stack: "immich", services: ["server"] }`, stack points `server` + `machine-learning` → `points` only `server`; step without services → `points: null`; stack with a pending job → `disabled: true`; services with no point → null. `stepVersions` — `[{ stack: "immich", services: ["server", "machine-learning"], from: null, to: "server, machine-learning" }]` → `"immich (server, machine-learning)"`; a version step `v1 → v2` unchanged. `stackRollbackTitle` — points only → `"Revenir aux images précédentes ?"`; stack-level row `to: "v3.4.0"` → `"Revenir à v3.4.0 ?"`.
  - `update.service.test.ts`: `"a rollback of every point has no single from"`: two points → step `from === null`.
- [ ] **Step 2:** `cd apps/portail && bun --bun vitest run lib/updates-view.test.ts` and `cd apps/updater && bun --bun vitest run src/update/update.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, then the components: the panel renders one destructive button per point, « Revenir à <to> (<service>) », calling `onRollback(stack, service)`, or the existing single button when `points` is null; all disabled when `disabled`. History uses `stepVersions`. In the updater, the rollback step's `from` is `null` when it restores points without a `service`.
- [ ] **Step 4:** Portal and updater suites, typecheck, then `bun run e2e` from the root (adapt only assertions on the changed texts). Expected: PASS.
- [ ] **Step 5:** Commit `fix(portail): failed-job rollback targets the failed images, clearer multi-image labels`.
