# Updater — per-image updates, download progress, job queue — design

Date: 2026-10-25

## Why

The updates page shows one row per stack with a single "from → to". The owner wants to see, before acting, **which images of a stack will change**, and to update them **one after the other, when they choose**, rather than the whole stack at once. While an update runs, they want a **progress bar per image**. And they do not want to wait for one update to finish before asking for the next one.

Detection already computes everything per service (`StackStatus.services`: image, kind, current, available, update); the portal just does not show it. Updates, rollbacks and job handling are per stack and one at a time.

## Goals

1. **Expandable stacks.** Each stack row in the updates table (and the mobile cards) expands to list its services: service name, image tag, kind (floating / variable / literal / pinned, in plain French), current → available (or new image date), error if any.
2. **Selective update, pull-style stacks.** In a stack whose update goes through the pull strategy (see "Which stacks allow a selection"), each service with an update gets a checkbox, **checked by default**. The stack row has two buttons: **« Tout mettre à jour »** (every selectable service, i.e. the selection with every box checked) and **« Mettre à jour la sélection (n) »** (checked ones only, disabled when n = 0). Literal and pinned services are listed without a checkbox.
3. **Variable / recipe stacks** expand too, but keep a single update button for the whole stack (their services move together through one variable).
4. **Same flow for a selection as for a whole stack:** `before` commands run first (same rules as today), then the selected images are downloaded, only their containers are recreated, then the **health of the whole stack** is checked.
5. **Per-image download progress.** During the download, each image being pulled shows a progress bar (percentage and downloaded/total size) on its line in the expanded stack, then "téléchargée" / "déjà à jour".
6. **Per-image rollback** (pull-style updates). Each updated image keeps its own rollback point. Its line shows « Revenir à … »; rolling it back touches only that image (retag, recreate that container) and then checks the health of the whole stack. The stack row also shows **« Tout remettre en arrière »**, which rolls back every image of the stack that has a rollback point, in one job.
7. **Job queue.** Clicking update / rollback / update-all / check while a job runs **queues** the request instead of refusing it (today: 409 `BusyError`, buttons disabled). Queued jobs run in order, one at a time. Buttons stay enabled while a job runs; a stack with a queued or running job shows it ("en attente", "en cours"). Updates of a stack can be queued behind other jobs of the same stack; a rollback cannot (see "Queue").

## Non-goals

- Cancelling or reordering queued jobs.
- Running jobs in parallel.
- Selective update or per-image rollback for variable/recipe stacks.
- Progress bars for anything other than image downloads (recreate, health check, `before` commands stay as log lines).
- Changing how detection decides what has an update, or the global « Tout mettre à jour » (update-all) logic beyond what queuing and per-image rollback points imply.
- Resuming queued jobs after an updater restart.

## Anti-goals (a failure even if it works)

- Rewriting what Docker Compose does (reading compose files, resolving `.env`, recreating containers by hand through the Engine API). Compose stays the tool for config and `up`.
- A rollback point saved before this change that no longer works after deploying it (an existing `rollbacks` row of kind `pull`, `version` or `recipe` must still roll back).
- Updating a selection silently recreating or pulling images that were not selected.
- Progress events flooding the SSE stream or the job log table.

## Constraints

- Monorepo: `apps/updater` (NestJS 12, Bun, `bun:sqlite`, vitest), `apps/portail` (Next.js, shadcn), shared Zod schemas in `packages/shared/updater-api.ts`. Code comments in English, user-facing text in French. Existing conventions from `2026-10-25-updater-modules-design.md` apply (explicit `@Inject`, pure functions stay functions, strategies behind `UpdateStrategy`).
- The updater runs in a container with `/var/run/docker.sock` and `/root` mounted (`deploy/updater-compose.yml`) and the docker CLI + compose plugin installed.
- Every existing test keeps passing, adapted where behaviour intentionally changes (409 busy → queued, whole-stack pull update → selectable services only).

## Decisions

### Downloads through the Docker Engine API, the rest through the CLI

- Docker Compose has no API; it is a client. Image downloads move to the Engine API over the mounted socket: `POST /images/create?fromImage=…&tag=…` streams one JSON object per layer event (`status`, `id`, `progressDetail.current/total`). Bun's `fetch` supports `unix:` sockets.
- Per image, progress counts download bytes only: `progressDetail` of `Downloading` events per layer. `Extracting` events also carry `progressDetail` and must not be summed (the bar would fill twice). Layers reported `Already exists`, `Download complete` or `Pull complete` count as fully downloaded. The total grows while layers are still being announced; the displayed percentage never goes backwards. An image is done when the stream ends without an `error` field; "up to date" comes from the final `Status: Image is up to date …` line. A stream `error` fails the update like a failed `compose pull` does today.
- `docker compose config`, `ps`, `up`, image tag/rm stay on the CLI.
- The pull step downloads the images of the services the update targets: the selection (« Tout mettre à jour » and a request without `services` = every selectable service) for the pull strategy; for version/recipe updates, every service with an image (as `compose pull` does today), resolved after the variable has been written.
- **Intentional change for pull-style stacks:** a whole-stack update no longer downloads every image of the stack. A floating service whose check failed (registry error) is no longer pulled along; it will be once a check succeeds, and its error stays visible on its line meanwhile. Literal services are no longer pulled (their tag does not move, so this was a no-op).
- `compose pull` honours `pull_policy` (`build`, `never` skip the service) and `platform`; the API download must do the same (skip those services, pass `platform` to `/images/create`).
- Registry credentials: today `compose pull` uses the CLI's credentials (`~/.docker/config.json`, mounted via `/root`). Downloads through the API must keep working for every image the CLI can pull today. **Builder's call** how: send `X-Registry-Auth` built from the CLI config, or fall back to `docker pull` (no progress) for an image whose registry needs credentials. If the CLI config uses a `credsStore` or `credHelpers`, building `X-Registry-Auth` means calling that helper. Check the real stacks' images and the CLI config to see whether any of this is needed.

### Recreating only the selected services

After the pull, a pull-style update (selection or « Tout ») runs `docker compose up -d --no-deps <services…>`: without `--no-deps`, compose would also start stopped dependencies, and only the targeted containers may change. A stack that was stopped before the update stays stopped (images downloaded, nothing started), as today. Version/recipe updates keep `up -d` on the whole stack.

### Which stacks allow a selection

Exactly the stacks for which `Strategies.forUpdate` picks the pull strategy: `mode === "pull"`, or a version/recipe stack whose variable has no target (`available === null`, only a floating sidecar changed). Only services of kind `floating` with `update: true` are selectable. The status sent to the portal must say whether a stack allows a selection, so the portal does not duplicate that rule (field name: builder's call).

### Major bump and confirmation of a selection

Today `StackStatus.major` and `needsConfirm` come from the first service with an update (`detection.service.ts`), which may not be selected. For a pull-style update (selection or « Tout »), they are computed over the targeted services: a service is a major bump when `isMajorBump(current, available)` holds for it; the update is major if any targeted service is. This drives the confirmation (`config.confirm` still forces it), the `before` rule (`beforeOnlyOnMajor`) and the `major` stored in each service's rollback point. Version/recipe updates keep the stack-level values.

### API

- `POST stacks/:name/update` body gains an optional `services: string[]`. Absent = the whole stack: every selectable service for a pull-style stack (same as « Tout mettre à jour »), unchanged for version/recipe stacks. Present on a stack that does not allow a selection, empty, or naming a service that is not selectable → 400.
- `POST stacks/:name/rollback` body gains an optional `service: string`. Absent = « Tout remettre en arrière » (every rollback point of the stack, or the stack-level version/recipe rollback as today). Refused with 409 while the stack has a queued or running job (see "Queue").
- `StackStatus` exposes the rollback points per service for pull-style rollbacks (`to` and `major` per service) in addition to today's stack-level `rollback`, which keeps meaning "something can be rolled back on this stack" for the stack-level button. Exact shape: builder's call, in `updater-api.ts`.
- Update / rollback / update-all / check responses stay `{ jobId }` (or `needsConfirm`), whether the job starts now or is queued.

### Per-image rollback storage

- Pull-style rollback points become **one per service**: a service updated again replaces its own point (one level deep, like today per stack). Updating `server` then `machine-learning` separately leaves two independent points.
- `PullStrategy.prepare` tags only the targeted services' running images (`updater-rollback/<project>-<service>:latest`, unchanged tag format) and saves only their points; points of other services are left alone.
- Version/recipe rollbacks stay stack-level, unchanged. A stack has either pull points or a version/recipe rollback; a version/recipe update replaces any pull points of that stack (removing their tags), and vice-versa, so the stack never holds both.
- Storage: builder's call (new table keyed by stack + service, or a new `data` shape in `rollbacks`). An existing `pull` row (several services, one stack) must still be rolled back, either migrated at start-up into per-service points or read as-is.
- Rolling back one service: retag its saved image, remove its rollback tag and point, `compose up -d <service>` if the stack was running before that update, then the whole-stack health check. « Tout remettre en arrière » does the same for every point in one job (one `up`, one health check).
- `running` (was the stack up before the update) and `major` are stored per point, from the update that created it (`major` as defined in "Major bump and confirmation of a selection"). A point's `to` is that service's `current` at update time, or its image date / « l'image précédente » when it has no version.
- « Tout remettre en arrière » with mixed points: every image is retagged, but only the services whose point has `running: true` are started; the health check runs if any was.
- Points of services that have left the compose file (today handled by `removeStaleRollbackTags` for the whole stack): dropped, with their tag, at the next update of the stack; a rollback skips them with a log line rather than running `up` on a service that no longer exists.

### Queue

- `JobRunner` keeps one running job and a FIFO of queued jobs. A queued job is created in the store with a new status **`queued`** (added to `jobStatusSchema`), becomes `running` when its turn comes, and is followed over SSE like any job (the stream waits, then replays as today).
- Requests are validated when queued (unknown stack, no applicable update → 400 as today); the job re-reads status and config when it runs, as `runUpdate` already does. If by then nothing targeted still needs an update (`update: false` in the re-read status, e.g. already done by an earlier job), the step ends as success with a log line saying there was nothing left to do. This applies to every mode: a version stack must not reach `VersionStrategy.prepare`, which fails with `notNewerMessage` in that case.
- **What was confirmed is what runs.** A queued job keeps the target validated when it was queued (per stack: from/to, or the targeted services). If, when it runs, the re-read status offers a different target or now needs a confirmation that was not given (e.g. a check queued in between found a newer major), the step fails with a message telling the user to start the update again; it never applies the new target. Same for update-all: its stacks and their targets are those planned at queue time.
- **Rollbacks are not queued behind work on the same stack.** A rollback (one image or all) is refused with 409 while the stack has a queued or running job (an update, a rollback, or an update-all that includes it), message such as « Une tâche est déjà prévue pour immich, attends qu'elle se termine ». So the point restored is the one the user saw, and the step's `to` is right. Updates of a stack can still be queued behind other jobs of the same stack (update `server`, then `machine-learning`, without waiting); overlapping ones end as "nothing left to do".
- A queued job's `startedAt` is set when it starts running; until then it holds the queue time (history sorts by id, so order is unaffected). `idle()` resolves only when the queue is empty. `follow()` today ends a stream immediately for a job that is not running: a `queued` job must wait instead.
- On start-up, jobs left `queued` are marked `interrupted`, like running ones.
- The scheduler's automatic check keeps skipping when a job is running or queued (it does not queue itself).
- `StacksResponse` exposes the queued jobs (id, kind, stacks concerned) next to `runningJob`, so the portal can mark stacks "en attente".

### Progress events

- New `JobEvent` type `progress`: stack, service, image, downloaded bytes, total bytes, state (`downloading` | `done` | `up-to-date`). Emitted at most a few times per second per image, never written to the job log table. One log line per image at start and end stays in the log.
- A follower connecting mid-download receives the latest progress of each image in the replay (kept in memory for the running job only).

### Portal

- `stacks-table.tsx` / `stacks-cards.tsx`: expand/collapse per stack (collapsed by default), service lines as in the approved mockup (`2026-10-25-per-image-updates-mockup.html`, next to this spec): checkbox, name, tag badge, versions, progress bar or « Revenir à … » on the right. The stack row shows the two update buttons (pull-style) or the single one (variable/recipe), and « Tout remettre en arrière » when any rollback exists.
- Buttons are no longer disabled because a job runs. A stack with a queued or running job shows that state; its rollback buttons are disabled (the API refuses them anyway); its update buttons stay enabled, except for services already targeted by a queued or running job, whose checkbox is shown but cannot be checked (this also prevents double clicks).
- Job steps of a selection show the targeted services' versions, not the stack-level from/to (which may belong to an unselected service). Exact form: builder's call.
- Version/recipe rollbacks still go through `compose up -d --pull missing`: no progress bar there, consistent with the non-goals.
- Confirmations (`needsConfirm`, rollback migration warning) work as today, for a selection and for a single-image rollback (warning based on that point's `major`).
- The stack row's « Tout mettre à jour » sits next to the page-level « Tout mettre à jour » (update-all). **My call (designer):** keep the mockup's « Tout mettre à jour » on the row; the builder may rename the page-level one to « Mettre à jour toutes les stacks » if the duplication reads badly in the real page.

## Left to the builder

- Module/file layout, names of new types and fields, DB schema.
- How the Engine API client is wired (a new provider next to `DOCKER`, or methods on `Docker`), and test fakes for it.
- Throttling interval for progress events.
- Registry credentials approach (see above).
- Exact French wording of new labels beyond those quoted above.
