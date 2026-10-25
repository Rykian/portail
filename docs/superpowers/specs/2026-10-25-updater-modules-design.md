# Updater — NestJS modules — design

Date: 2026-10-25

## Why

`updater/src/` has 30 files side by side (code and tests mixed); only `http/` is a folder. Some files do several things at once (`service.ts` is a catch-all behind every route, `update.ts` mixes the shared update flow with the three ways of updating), and there are almost no comments. Opening the updater, you cannot see how it is cut.

Goal: clarity. The owner knows NestJS and wants its usual shape: one module per domain, each one stating what it provides and what it depends on, so the structure reads from the folder tree and the module files.

## Goals

- Real NestJS modules: Nest builds the application and injects dependencies; `main.ts` stops wiring everything by hand.
- Each module owns its controller(s); no catch-all `http` module, no `UpdaterService`.
- The three ways of updating a stack (pull, version variable, Authentik minor) become strategies behind one interface, in their own module. Detection, update and rollback no longer know about Authentik.
- Large files split by responsibility.
- Comments: a header on each module saying what it is for, and comments on functions whose role is not obvious. Not every line.

## Non-goals

- Any behaviour change. Same API (routes, bodies, responses, status codes, headers), same updates, same logs, same messages. The portal sees no difference.
- New features, new recipes, new config options.
- Changing the database schema or the stored data.

## Anti-goals (a failure even if it works)

- Turning pure functions into injectable services for the sake of it (`versions`, `env-file`, `image-ref`, health evaluation, `docker-cli` parsing, `planUpdateAll`). They stay functions, in their module's folder, tested directly. Layers that add no clarity are the opposite of the goal.
- A rollback saved before the refactor that no longer works after deploying it.

## Constraints

- Runtime: Bun; tests: `bun --bun vitest run`; NestJS 12 with Express. Existing providers use explicit `@Inject(TOKEN)`; whether vitest's transform emits decorator metadata is unverified, so keep explicit `@Inject` for every constructor dependency unless the builder verifies type-based injection works in both `bun src/main.ts` and vitest.
- Stored rollbacks keep their exact format: `data.kind` is `"pull" | "version" | "recipe"` with the current fields. The `"recipe"` kind is the Authentik minor strategy's rollback.
- `config.yml` keeps `recipe: authentik` as is; `UpdateMode` (`"pull" | "version" | "recipe"`) in `@shared/updater-api` is unchanged.
- SQLite tables and their contents unchanged; split stores share one connection.
- Environment variables unchanged (`UPDATER_TOKEN`, `PORT`, `UPDATER_ROOT`, `UPDATER_CONFIG`, `UPDATER_DATA`). Missing token still exits with the same message before listening. Start-up still marks interrupted jobs and logs the count. SIGTERM still stops the scheduler and closes the app.
- Comments in English, like the existing code; user-facing messages stay in French.
- Every existing test keeps passing (moved and rewired as needed, assertions unchanged in meaning). The HTTP tests remain the proof the API is identical.

## Decisions

### Modules

| Module | Provides | Controller routes |
|---|---|---|
| **config** | `ConfigService` (loads and validates `config.yml`, keeps the last valid one; today's `createConfigLoader`) | — |
| **database** | the SQLite connection and table creation | — |
| **docker** | `Docker` (CLI implementation) and `Registry`; image refs | — |
| **stacks** | stack discovery, `StackStatusStore` (stack statuses + meta), `RollbackStore` (rollbacks); env-file helpers | — |
| **strategies** | the strategy interface, the three strategies, and a `Strategies` service that picks one and gives the available target | — |
| **detection** | `DetectionService` (per-service check, `check` job, stack list) | `GET /stacks`, `POST /checks` |
| **update** | `UpdateService` (single update with confirmation, rollback, update-all), `StackUpdater` (shared flow: saving the rollback, `before` commands, pull/up, health check, rollback run); health evaluation | `POST /stacks/:name/update`, `POST /stacks/:name/rollback`, `POST /updates` |
| **jobs** | `JobRunner`, `JobStore` (jobs + logs) | `GET /jobs/:id`, `GET /jobs/:id/events`, `GET /history` |
| **scheduler** | a service running the 6-hourly check (and at start-up when the last is older) and the daily log purge, started and stopped with the app | — |
| **root (`AppModule`)** | `GET /health`, the global auth guard and error filter, imports the others | `GET /health` |

Modules without a controller are fine.

### Dependency direction (my call, after review)

Module imports point one way only, no `forwardRef`:

```
config, database, docker
  └─ stacks (database)
       ├─ jobs (database)
       ├─ strategies (docker, stacks)
       ├─ detection (config, docker, stacks, strategies, jobs)
       ├─ update (config, docker, stacks, strategies, detection, jobs)
       └─ scheduler (detection, jobs)
```

The **stacks** module was added to the earlier list for this: detection and update both need discovery, statuses and rollbacks, and update needs detection to re-check a stack after an update. Shared helpers used by both update and strategies (`fail`, `notNewerMessage`, env-file) live in stacks or next to the strategy interface, never in update.

### Store split

The single `Store` is split by domain: `JobStore` (jobs, job_logs) in jobs, `StackStatusStore` (stacks, meta) and `RollbackStore` (rollbacks) in stacks. The database module owns the connection and creates the tables. Tables and data are untouched.

### Strategies

Interface with four operations:

1. **prepare** — check the target and return the rollback data (`StackUpdater` persists it, and for pull also handles the rollback image tags; my call, so strategies never write to `RollbackStore`);
2. **preview** — optional; only Authentik minor has one (the compose diff shown before confirming);
3. **apply**;
4. **restore** — put back what `prepare` saved.

Implementations:

- **pull** — save current images (rollback tags), pull and up.
- **version** — rewrite the version variable in its file.
- **authentik-minor** — replace the compose file with upstream's for the target minor, then rewrite the variable.

The strategy is chosen **per update**, not per stack, exactly as today:
- Authentik patch → version; Authentik minor → authentik-minor.
- A version (or recipe) stack whose variable has no target (only a floating sidecar changed) → pull.

Detection also needs the strategy layer at check time: `Strategies` exposes a method giving, for a service's tags, the available target and whether it needs confirmation (today `authentikTarget` returning patch/minor, minor → `needsConfirm`). `status.mode` and `status.recipe` stay plain data copied from the config. The Authentik cases in `detection.test.ts` may move to strategies tests as long as each case is still covered (my call).

Restoring dispatches on the stored `data.kind`, so pre-refactor rollbacks restore through the matching strategy.

The shared flow (`before` commands, pull/up, health check, rollback sequencing, removing rollback image tags) stays in update's `StackUpdater`; strategies only hold what differs. Authentik-specific target choice (patch first, then next minor) moves out of detection into the strategies module.

### Per-run context

`StackContext` today carries `docker`, `store` and `log` as a hand-made injection bag. Injected dependencies move to constructors; the per-run context keeps only the stack, its config, its status and the log sink.

### Tests

Tests stay next to the file they test and move with it into the module folders. `src/test/fakes.ts` stays shared.

## Left to the builder

- Exact folder and file names, injection tokens, how `now` and `fetch` are provided so tests can substitute them.
- Exact shape of the strategy interface, as long as it covers the four operations above and the per-update choice.
- Whether service-level tests build services by hand or through `@nestjs/testing`.
- Order of the refactor steps, provided tests pass after each step.
