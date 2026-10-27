import { expect, test } from "vitest";
import {
  MIGRATION_WARNING,
  type ImageProgress,
  type PendingJob,
  type ServiceStatus,
  type StackStatus,
} from "@portail/shared/updater-api";
import {
  imageTag,
  jobFinished,
  jobPanelLabel,
  lockedServices,
  mergeProgress,
  progressLabel,
  progressPercent,
  rollbackWarning,
  selectableServices,
  serviceChange,
  serviceKindLabel,
  serviceRollbackWarning,
  stackJobState,
  stackRow,
  stepTitle,
  updateAllCount,
} from "./updates-view";

function service(fields: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: "app",
    image: "example/app:latest",
    kind: "floating",
    current: null,
    available: null,
    newImageDate: null,
    update: false,
    error: null,
    ...fields,
  };
}

function stack(fields: Partial<StackStatus> = {}): StackStatus {
  return {
    name: "app",
    mode: "pull",
    confirm: false,
    last: false,
    recipe: null,
    services: [service()],
    update: false,
    button: false,
    current: null,
    available: null,
    major: false,
    needsConfirm: false,
    rollback: null,
    selectable: false,
    serviceRollbacks: [],
    error: null,
    checkedAt: null,
    ...fields,
  };
}

test("an up-to-date stack", () => {
  expect(stackRow(stack())).toEqual({ kind: "up-to-date" });
});

test("a version change", () => {
  expect(stackRow(stack({ update: true, button: true, current: "v3.4.0", available: "v3.5.0" }))).toEqual({
    kind: "update",
    label: "v3.4.0 → v3.5.0",
    detail: null,
  });
});

test("one new image with a date", () => {
  const row = stackRow(
    stack({
      update: true,
      button: true,
      services: [service({ update: true, newImageDate: "2026-10-20T00:00:00.000Z" })],
    }),
  );
  expect(row).toEqual({ kind: "update", label: "nouvelle image du 20/10/2026", detail: null });
});

test("several new images list the updated services", () => {
  const row = stackRow(
    stack({
      update: true,
      button: true,
      services: [
        service({ name: "radarr", update: true }),
        service({ name: "sonarr", update: true, newImageDate: "2026-10-20T00:00:00.000Z" }),
        service({ name: "gluetun" }),
      ],
    }),
  );
  expect(row).toEqual({ kind: "update", label: "nouvelles images", detail: "radarr, sonarr" });
});

test("a literal version: no button, a hint", () => {
  const row = stackRow(
    stack({
      update: true,
      button: false,
      current: "1.31.6-alpine",
      available: "1.31.7-alpine",
      services: [service({ kind: "literal", update: true })],
    }),
  );
  expect(row).toEqual({ kind: "literal", label: "nouvelle version disponible : 1.31.6-alpine → 1.31.7-alpine" });
});

test("an error wins", () => {
  expect(stackRow(stack({ update: true, button: true, error: "registre injoignable" }))).toEqual({
    kind: "error",
    message: "registre injoignable",
  });
});

test("a stack with a rollback and no update is not collapsed", () => {
  expect(stackRow(stack({ rollback: { to: "v3.4.0", major: false } }))).toEqual({ kind: "rollback-only" });
});

test("update-all counts only stacks it would update", () => {
  const stacks = [
    stack({ name: "a", update: true, button: true }),
    stack({ name: "b", update: true, button: false }),
    stack({ name: "c", update: true, button: true, needsConfirm: true }),
    stack({ name: "d", update: true, button: true, error: "boom" }),
    stack({ name: "e" }),
    stack({ name: "f", update: true, button: true }),
  ];
  expect(updateAllCount(stacks)).toBe(2);
});

test("the rollback warns about database migrations for confirm, recipe and major updates only", () => {
  expect(rollbackWarning(stack())).toBeNull();
  expect(rollbackWarning(stack({ confirm: true }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ recipe: "authentik" }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ rollback: { to: "v3.4.0", major: true } }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ major: true, rollback: { to: "v3.4.0", major: false } }))).toBeNull();
});

/** The mockup's immich: two floating images with an update, a literal and a pinned one. */
function immich(fields: Partial<StackStatus> = {}): StackStatus {
  return stack({
    name: "immich",
    selectable: true,
    update: true,
    button: true,
    services: [
      service({
        name: "server",
        image: "ghcr.io/immich-app/immich-server:latest",
        current: "v1.140",
        available: "v1.141",
        update: true,
      }),
      service({
        name: "machine-learning",
        image: "ghcr.io/immich-app/immich-machine-learning:latest",
        newImageDate: "2026-10-22T08:00:00.000Z",
        update: true,
      }),
      service({ name: "redis", image: "redis:7.4", kind: "literal", current: "7.4" }),
      service({ name: "postgres", image: "postgres@sha256:abc", kind: "pinned" }),
    ],
    ...fields,
  });
}

function progress(fields: Partial<ImageProgress> = {}): ImageProgress {
  return {
    stack: "immich",
    service: "machine-learning",
    image: "ghcr.io/immich-app/immich-machine-learning:latest",
    downloaded: 0,
    total: 0,
    state: "downloading",
    ...fields,
  };
}

function pendingJob(fields: Partial<PendingJob> = {}): PendingJob {
  return { id: 7, kind: "update", status: "running", targets: [], ...fields };
}

test("service kinds in plain French", () => {
  expect(serviceKindLabel("floating")).toBe("flottante");
  expect(serviceKindLabel("variable")).toBe("variable");
  expect(serviceKindLabel("literal")).toBe("version en dur");
  expect(serviceKindLabel("pinned")).toBe("figée");
});

test("a service's change: versions, else the new image date, else nothing", () => {
  const [server, ml, redis] = immich().services;
  expect(serviceChange(server)).toBe("v1.140 → v1.141");
  expect(serviceChange(ml)).toBe("image du 22/10/2026");
  expect(serviceChange(redis)).toBeNull();
});

test("the tag shown for an image", () => {
  expect(imageTag("ghcr.io/immich-app/immich-server:latest")).toBe("latest");
  expect(imageTag("localhost:5000/app:1.2")).toBe("1.2");
  expect(imageTag("localhost:5000/app")).toBe("latest");
  expect(imageTag("redis")).toBe("latest");
  expect(imageTag("postgres:16@sha256:abc")).toBe("@sha256");
  expect(imageTag("postgres@sha256:abc")).toBe("@sha256");
});

test("selectable services: floating ones with an update, on a stack that allows a selection", () => {
  expect(selectableServices(immich())).toEqual(["server", "machine-learning"]);
  expect(selectableServices(immich({ selectable: false }))).toEqual([]);
});

test("a stack's job state: running wins over queued", () => {
  const queued = pendingJob({ id: 8, status: "queued", targets: [{ stack: "immich", services: null }] });
  const running = pendingJob({ targets: [{ stack: "immich", services: ["server"] }] });
  expect(stackJobState("immich", [])).toBeNull();
  expect(stackJobState("immich", [queued])).toBe("queued");
  expect(stackJobState("immich", [running, queued])).toBe("running");
  expect(stackJobState("mealie", [running, queued])).toBeNull();
});

test("locked services are those a pending job targets", () => {
  const running = pendingJob({ targets: [{ stack: "immich", services: ["server"] }] });
  expect(lockedServices(immich(), [running])).toEqual(new Set(["server"]));
  const whole = pendingJob({ kind: "update-all", targets: [{ stack: "immich", services: null }] });
  expect(lockedServices(immich(), [whole])).toEqual(new Set(["server", "machine-learning"]));
  expect(lockedServices(immich(), [pendingJob({ targets: [{ stack: "mealie", services: null }] })])).toEqual(new Set());
});

test("progress labels", () => {
  expect(progressLabel(progress({ downloaded: 0.4e9, total: 1.5e9 }))).toBe("27 % · 0,4/1,5 Go");
  expect(progressLabel(progress({ downloaded: 12e6, total: 85e6 }))).toBe("14 % · 12,0/85,0 Mo");
  expect(progressLabel(progress())).toBe("…");
  expect(progressLabel(progress({ state: "done" }))).toBe("téléchargée");
  expect(progressLabel(progress({ state: "up-to-date" }))).toBe("déjà à jour");
});

test("the displayed percentage never goes backwards while layers are announced", () => {
  const first = progress({ downloaded: 50, total: 100 });
  // A new layer grows the total: 60/200 would show 30 % after 50 %.
  expect(mergeProgress(first, progress({ downloaded: 60, total: 200 }))).toBe(first);
  const caughtUp = progress({ downloaded: 120, total: 200 });
  expect(mergeProgress(first, caughtUp)).toBe(caughtUp);
  const done = progress({ state: "done" });
  expect(mergeProgress(first, done)).toBe(done);
  expect(mergeProgress(undefined, first)).toBe(first);
});

test("a step of a selection names its services", () => {
  expect(stepTitle({ stack: "immich", status: "pending", from: null, to: null, services: ["server", "redis"] })).toBe(
    "immich (server, redis)",
  );
  expect(stepTitle({ stack: "mealie", status: "pending", from: "v1", to: "v2" })).toBe("mealie");
});

test("a queued job is not finished", () => {
  expect(jobFinished("queued")).toBe(false);
  expect(jobFinished("running")).toBe(false);
  expect(jobFinished("success")).toBe(true);
  expect(jobFinished("interrupted")).toBe(true);
});

test("rolling back one image warns on that image's major, or the stack's confirm or recipe", () => {
  const point = { service: "server", to: "v1.140", major: false };
  expect(serviceRollbackWarning(immich({ rollback: { to: "2 image(s)", major: true } }), point)).toBeNull();
  expect(serviceRollbackWarning(immich(), { ...point, major: true })).toBe(MIGRATION_WARNING);
  expect(serviceRollbackWarning(immich({ confirm: true }), point)).toBe(MIGRATION_WARNING);
});

test("the panel says « en attente » until a queued job starts", () => {
  const pending = { stack: "immich", status: "pending" as const, from: null, to: null };
  expect(jobPanelLabel({ status: null, lines: [], steps: [pending] }, true)).toBe("en attente");
  expect(jobPanelLabel({ status: null, lines: ["== immich"], steps: [pending] }, true)).toBe("en cours");
  expect(jobPanelLabel({ status: null, lines: [], steps: [{ ...pending, status: "running" }] }, true)).toBe("en cours");
  expect(jobPanelLabel({ status: null, lines: [], steps: [] }, false)).toBe("en cours");
  expect(jobPanelLabel({ status: "failed", lines: [], steps: [] }, true)).toBe("échouée");
});

test("the bar's percentage", () => {
  expect(progressPercent(progress({ downloaded: 0.4e9, total: 1.5e9 }))).toBe(27);
  expect(progressPercent(progress())).toBe(0);
  expect(progressPercent(progress({ state: "up-to-date" }))).toBe(100);
});
