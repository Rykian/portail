import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { TestingModule } from "@nestjs/testing";
import type { JobTarget, StackStatus } from "@portail/shared/updater-api";
import { beforeEach, expect, test, vi } from "vitest";
import { BadRequestError, ConflictError, NotFoundError } from "../common/errors";
import { openDatabase } from "../database/database";
import { DetectionService } from "../detection/detection.service";
import type { ComposeService } from "../docker/docker";
import { JobRunner } from "../jobs/job-runner";
import { JobStore } from "../jobs/job.store";
import { RollbackStore } from "../stacks/rollback.store";
import { StackStatusStore } from "../stacks/stack-status.store";
import { VersionStrategy } from "../strategies/version.strategy";
import { FakeDocker, FakeImagePuller, FakeRegistry, tempDir } from "../test/fakes";
import { testModule } from "../test/module";
import { UpdateService } from "./update.service";

const NOW = new Date("2026-10-24T10:00:00.000Z");
const WARNING =
  "Ce service migre peut-être sa base au démarrage : le retour arrière peut échouer, la vraie sauvegarde est le vzdump.";
const LOCAL_MODIFICATIONS = "Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml";
const upstream08 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.8.4}\n    restart: always\n";
const upstream10 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.10.2}\n    restart: unless-stopped\n";

let root: string;
let configPath: string;
let docker: FakeDocker;
let puller: FakeImagePuller;
let registry: FakeRegistry;
let database: Database;
let moduleRef: TestingModule;
let rollbacks: RollbackStore;
let jobStore: JobStore;
let jobs: JobRunner;
let detection: DetectionService;
let service: UpdateService;

const fetchFn = (async (url: string) =>
  new Response(url.includes("2026.10") ? upstream10 : upstream08, { status: 200 })) as unknown as typeof fetch;

beforeEach(async () => {
  root = await tempDir();
  configPath = join(root, "config.yml");
  docker = new FakeDocker();
  puller = new FakeImagePuller();
  registry = new FakeRegistry();
  database = openDatabase(":memory:");
  moduleRef = await testModule({
    database,
    docker,
    puller,
    registry,
    fetch: fetchFn,
    now: () => NOW,
    env: { root, configPath },
  });
  rollbacks = moduleRef.get(RollbackStore);
  jobStore = moduleRef.get(JobStore);
  jobs = moduleRef.get(JobRunner);
  detection = moduleRef.get(DetectionService);
  service = moduleRef.get(UpdateService);
});

async function makeStack(name: string, services: ComposeService[], files: Record<string, string> = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "compose.yml"), "services: {}\n");
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  docker.services.set(dir, services);
  return dir;
}

async function check() {
  detection.check(null);
  await jobs.idle();
}

const WEB = "lscr.io/linuxserver/web:latest";

/** Only running services get a rollback point. */
const webRunning = () =>
  docker.containersByDir.set(join(root, "web"), [
    { service: "web", state: "running", exitCode: 0, health: null, imageId: "old" },
  ]);

/** A floating-tag stack whose download brings the new image. */
async function floatingStack(labels: { local: string | null; remote: string | null }) {
  await makeStack("web", [{ name: "web", image: WEB, rawImage: WEB, pullPolicy: null, platform: null }]);
  docker.images.set(WEB, {
    id: "old",
    repoDigests: ["lscr.io/linuxserver/web@sha256:old"],
    version: labels.local,
    created: null,
  });
  registry.digests.set("linuxserver/web:latest", "sha256:new");
  registry.detailsByRef.set("linuxserver/web:latest", { version: labels.remote, created: "2026-10-01T00:00:00Z" });
  puller.onPull = (image) => {
    if (image === WEB) {
      docker.images.set(WEB, {
        id: "new",
        repoDigests: ["lscr.io/linuxserver/web@sha256:new"],
        version: labels.remote,
        created: null,
      });
    }
  };
}

async function authentikStack(compose: string) {
  const image = "ghcr.io/goauthentik/server:2026.8.4";
  await makeStack(
    "authentik",
    [
      {
        name: "server",
        image,
        rawImage: "ghcr.io/goauthentik/server:${AUTHENTIK_TAG:-2026.8.4}",
        pullPolicy: null,
        platform: null,
      },
    ],
    {
      "compose.yml": compose,
      ".env": "AUTHENTIK_TAG=2026.8.4\n",
    },
  );
  registry.tagsByRepository.set("goauthentik/server", ["2026.8.4", "2026.10.1", "2026.10.2"]);
  await writeFile(
    configPath,
    "stacks:\n  authentik:\n    recipe: authentik\n    version: { file: .env, variable: AUTHENTIK_TAG }\n",
  );
}

test("update on a confirm stack without confirm answers needsConfirm and starts nothing", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  await writeFile(configPath, "stacks:\n  web:\n    confirm: true\n");
  await check();
  const response = await service.update("web", {}, "a@b.c");
  expect(response).toEqual({ needsConfirm: { from: "1.0", to: "1.1", diff: null, warning: WARNING } });
  expect(jobs.running()).toBeNull();
  expect(jobStore.history(null).jobs).toEqual([]);

  const started = await service.update("web", { confirm: true }, "a@b.c");
  expect(started).toEqual({ jobId: expect.any(Number) });
  await jobs.idle();
});

test("a successful update re-checks the stack and records from/to on the step", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  webRunning();
  await check();
  const response = await service.update("web", {}, "a@b.c");
  if (!("jobId" in response)) throw new Error("expected a job");
  expect(jobStore.job(response.jobId)?.steps[0]).toMatchObject({ stack: "web", from: "1.0", to: "1.1" });
  await jobs.idle();

  const job = jobStore.job(response.jobId);
  expect(job).toMatchObject({ kind: "update", user: "a@b.c", status: "success" });
  expect(job?.steps[0]).toEqual({ stack: "web", status: "success", from: "1.0", to: "1.1", services: ["web"] });
  const web = detection.stacks().stacks.find((s) => s.name === "web");
  expect(web).toMatchObject({ update: false });
  expect(rollbacks.points("web")).toMatchObject([{ service: "web", to: "1.0" }]);
});

test("pull mode without version: rollback goes to « l'image précédente »", async () => {
  await floatingStack({ local: null, remote: null });
  webRunning();
  await check();
  await service.update("web", {}, null);
  await jobs.idle();
  expect(detection.stacks().stacks[0]).toMatchObject({ update: false });
  expect(rollbacks.points("web")).toMatchObject([{ service: "web", to: "l'image précédente" }]);
});

test("Authentik minor without confirm answers the upstream diff", async () => {
  await authentikStack(upstream08);
  await check();
  const response = await service.update("authentik", {}, null);
  if (!("needsConfirm" in response)) throw new Error("expected needsConfirm");
  expect(response.needsConfirm).toMatchObject({ from: "2026.8.4", to: "2026.10.2", warning: WARNING });
  expect(response.needsConfirm.diff).toContain("restart: unless-stopped");
  expect(jobs.running()).toBeNull();
});

test("Authentik minor with local modifications is refused", async () => {
  await authentikStack(upstream08.replace("restart: always", "restart: no"));
  await check();
  await expect(service.update("authentik", {}, null)).rejects.toThrow(new BadRequestError(LOCAL_MODIFICATIONS));
  await expect(service.update("authentik", {}, null)).rejects.toBeInstanceOf(BadRequestError);
});

test("Authentik preview network error is a bad request", async () => {
  await authentikStack(upstream08);
  await check();
  const failing = (
    await testModule({
      database,
      docker,
      registry,
      fetch: (async () => {
        throw new Error("réseau indisponible");
      }) as unknown as typeof fetch,
      now: () => NOW,
      env: { root, configPath },
    })
  ).get(UpdateService);
  await expect(failing.update("authentik", {}, null)).rejects.toThrow(new BadRequestError("réseau indisponible"));
});

test("update without button, unknown stack, queued behind a running job", async () => {
  await makeStack("lit", [
    { name: "db", image: "postgres:16.1.0", rawImage: "postgres:16.1.0", pullPolicy: null, platform: null },
  ]);
  registry.tagsByRepository.set("library/postgres", ["16.1.0", "16.2.0"]);
  await check();
  expect(detection.stacks().stacks[0]).toMatchObject({ update: true, button: false });
  await expect(service.update("lit", {}, null)).rejects.toBeInstanceOf(BadRequestError);
  await expect(service.update("nope", {}, null)).rejects.toBeInstanceOf(NotFoundError);

  await floatingStack({ local: "1.0", remote: "1.1" });
  await check();
  let release = () => {};
  jobs.start(
    { kind: "check", user: null, steps: [], targets: [] },
    () => new Promise((resolve) => (release = () => resolve("success"))),
  );
  const queued = await service.update("web", {}, null);
  if (!("jobId" in queued)) throw new Error("expected a job");
  expect(jobStore.job(queued.jobId)?.status).toBe("queued");
  release();
  await jobs.idle();
  expect(jobStore.job(queued.jobId)?.status).toBe("success");
});

test("rollback needs a rollback state, then restores and re-checks", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  webRunning();
  await check();
  await expect(service.rollback("web", {}, null)).rejects.toBeInstanceOf(BadRequestError);
  await expect(service.rollback("nope", {}, null)).rejects.toBeInstanceOf(NotFoundError);
  await service.update("web", {}, null);
  await jobs.idle();

  const job = await service.rollback("web", {}, "a@b.c");
  expect(job.kind).toBe("rollback");
  expect(job.steps[0]).toMatchObject({ stack: "web", to: "1.0" });
  await jobs.idle();
  expect(jobStore.job(job.id)?.status).toBe("success");
  expect(rollbacks.points("web")).toEqual([]);
});

test("a failed update exposes the rollback saved for it, and rollback() starts a job", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  docker.containersByDir.set(join(root, "web"), [
    { service: "web", state: "running", exitCode: 0, health: null, imageId: "old" },
  ]);
  await check();
  expect(detection.stacks().stacks[0]?.rollback).toBeNull();
  docker.composeExit = (args) => (args[0] === "up" ? 1 : 0);
  await service.update("web", {}, null);
  await jobs.idle();

  expect(rollbacks.points("web")).toMatchObject([{ service: "web", to: "1.0" }]);
  docker.composeExit = () => 0;
  const job = await service.rollback("web", {}, "a@b.c");
  expect(job.steps[0]).toMatchObject({ stack: "web", to: "1.0" });
  await jobs.idle();
  expect(jobStore.job(job.id)?.status).toBe("success");
  expect(rollbacks.points("web")).toEqual([]);
});

test("a version stack whose only change is a floating sidecar updates like pull mode", async () => {
  const sidecar = "postgres:16-alpine";
  await makeStack(
    "app",
    [
      {
        name: "app",
        image: "ghcr.io/acme/app:1.0.0",
        rawImage: "ghcr.io/acme/app:${APP_TAG}",
        pullPolicy: null,
        platform: null,
      },
      { name: "db", image: sidecar, rawImage: sidecar, pullPolicy: null, platform: null },
    ],
    { ".env": "APP_TAG=1.0.0\n" },
  );
  await writeFile(configPath, "stacks:\n  app:\n    version: { file: .env, variable: APP_TAG }\n");
  registry.tagsByRepository.set("acme/app", ["1.0.0"]);
  registry.digests.set("library/postgres:16-alpine", "sha256:new");
  docker.images.set(sidecar, { id: "old", repoDigests: ["postgres@sha256:old"], version: null, created: null });
  docker.containersByDir.set(join(root, "app"), [
    { service: "app", state: "running", exitCode: 0, health: null, imageId: "app" },
    { service: "db", state: "running", exitCode: 0, health: null, imageId: "old" },
  ]);
  puller.onPull = (image) => {
    if (image === sidecar) {
      docker.images.set(sidecar, { id: "new", repoDigests: ["postgres@sha256:new"], version: null, created: null });
    }
  };
  await check();
  expect(detection.stacks().stacks[0]).toMatchObject({ update: true, button: true, available: null });

  const response = await service.update("app", {}, null);
  expect(response).toEqual({ jobId: expect.any(Number) });
  await jobs.idle();
  expect(jobStore.history(null).jobs[0]).toMatchObject({ kind: "update", status: "success" });
  expect(await readFile(join(root, "app", ".env"), "utf8")).toBe("APP_TAG=1.0.0\n");
  expect(puller.calls).toEqual([{ image: sidecar, platform: null }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "db"]]);
  expect(rollbacks.points("app")).toMatchObject([{ service: "db", to: "l'image précédente" }]);
  expect(detection.stacks().stacks[0]).toMatchObject({ update: false });
});

test("update-all downloads a stopped stack without starting it", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  await check();
  const job = await service.updateAll(null);
  await jobs.idle();
  expect(jobStore.job(job.id)).toMatchObject({ status: "success", steps: [{ status: "success" }] });
  expect(puller.calls).toEqual([{ image: WEB, platform: null }]);
  expect(docker.composeCalls).toEqual([]);
  expect(jobStore.jobLog(job.id)).toContain("pile arrêtée : images téléchargées, pile laissée arrêtée");
});

test("updateAll runs the planned stacks, refuses when nothing to do", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  await expect(service.updateAll(null)).rejects.toThrow(new BadRequestError("Aucune mise à jour à appliquer"));
  await check();
  const job = await service.updateAll("a@b.c");
  expect(job.kind).toBe("update-all");
  expect(job.steps).toEqual([{ stack: "web", status: "pending", from: "1.0", to: "1.1", services: ["web"] }]);
  await jobs.idle();
  expect(jobStore.job(job.id)).toMatchObject({ status: "success", steps: [{ status: "success" }] });
  expect(detection.stacks().stacks[0]?.update).toBe(false);
});

/** Holds the queue with a running job until the returned function is called. */
function gate(targets: JobTarget[] = []): () => void {
  let release = () => {};
  jobs.start(
    { kind: "check", user: null, steps: [], targets },
    () => new Promise((resolve) => (release = () => resolve("success"))),
  );
  return () => release();
}

/** Replaces part of a stack's stored status, like a check that found something else. */
function changeStatus(name: string, change: (status: StackStatus) => StackStatus) {
  const store = moduleRef.get(StackStatusStore);
  const status = store.stackStatuses().find((s) => s.name === name)!;
  store.saveStackStatus(change(status));
}

const SERVER = "ghcr.io/immich-app/immich-server:release";
const ML = "ghcr.io/immich-app/immich-machine-learning:release";
const REDIS = "redis:latest";

/** A pull stack: `server` has a major bump, `machine-learning` a minor one, `redis` is up to date. */
async function immichStack() {
  await makeStack("immich", [
    { name: "server", image: SERVER, rawImage: SERVER, pullPolicy: null, platform: null },
    { name: "machine-learning", image: ML, rawImage: ML, pullPolicy: null, platform: null },
    { name: "redis", image: REDIS, rawImage: REDIS, pullPolicy: null, platform: null },
  ]);
  const images = [
    { image: SERVER, repository: "immich-app/immich-server", from: "1.0.0", to: "2.0.0" },
    { image: ML, repository: "immich-app/immich-machine-learning", from: "1.0.0", to: "1.1.0" },
  ];
  for (const { image, repository, from, to } of images) {
    docker.images.set(image, {
      id: `${image}-old`,
      repoDigests: [`ghcr.io/${repository}@sha256:old`],
      version: from,
      created: null,
    });
    registry.digests.set(`${repository}:release`, "sha256:new");
    registry.detailsByRef.set(`${repository}:release`, { version: to, created: "2026-10-01T00:00:00Z" });
  }
  docker.images.set(REDIS, { id: "redis", repoDigests: ["redis@sha256:same"], version: null, created: null });
  registry.digests.set("library/redis:latest", "sha256:same");
  docker.containersByDir.set(join(root, "immich"), [
    { service: "server", state: "running", exitCode: 0, health: null, imageId: `${SERVER}-old` },
    { service: "machine-learning", state: "running", exitCode: 0, health: null, imageId: `${ML}-old` },
    { service: "redis", state: "running", exitCode: 0, health: null, imageId: "redis" },
  ]);
  puller.onPull = (image) => {
    const pulled = images.find((i) => i.image === image);
    if (pulled) {
      docker.images.set(image, {
        id: `${image}-new`,
        repoDigests: [`ghcr.io/${pulled.repository}@sha256:new`],
        version: pulled.to,
        created: null,
      });
    }
  };
}

const MEALIE = "ghcr.io/mealie-recipes/mealie";

/** A version stack from v3.4.0 to v3.5.0; once the new image is pulled, compose resolves it. */
async function mealieStack() {
  const dir = await makeStack(
    "mealie",
    [
      {
        name: "mealie",
        image: `${MEALIE}:v3.4.0`,
        rawImage: `${MEALIE}:\${VERSION}`,
        pullPolicy: null,
        platform: null,
      },
    ],
    { ".env": "VERSION=v3.4.0\n" },
  );
  registry.tagsByRepository.set("mealie-recipes/mealie", ["v3.4.0", "v3.5.0"]);
  const previous = puller.onPull;
  puller.onPull = (image) => {
    previous(image);
    if (image.startsWith(MEALIE)) {
      docker.services.set(dir, [
        {
          name: "mealie",
          image: `${MEALIE}:v3.5.0`,
          rawImage: `${MEALIE}:\${VERSION}`,
          pullPolicy: null,
          platform: null,
        },
      ]);
    }
  };
  return dir;
}

const MEALIE_CONFIG = "stacks:\n  mealie:\n    version: { file: .env, variable: VERSION }\n";

test("services on a stack that does not allow a selection → 400", async () => {
  await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  await expect(service.update("mealie", { services: ["mealie"] }, null)).rejects.toThrow(
    new BadRequestError("Mise à jour par image impossible pour mealie"),
  );
});

test("empty selection → 400", async () => {
  await immichStack();
  await check();
  await expect(service.update("immich", { services: [] }, null)).rejects.toBeInstanceOf(BadRequestError);
  expect(jobStore.history(null).jobs.filter((j) => j.kind === "update")).toEqual([]);
});

test("unknown or not selectable service → 400", async () => {
  await immichStack();
  await check();
  await expect(service.update("immich", { services: ["server", "nope"] }, null)).rejects.toThrow(
    new BadRequestError("Service non sélectionnable : nope"),
  );
  await expect(service.update("immich", { services: ["redis"] }, null)).rejects.toThrow(
    new BadRequestError("Service non sélectionnable : redis"),
  );
});

test("without services, a pull stack updates every selectable service", async () => {
  await immichStack();
  await check();
  const response = await service.update("immich", {}, null);
  expect(response).toEqual({
    needsConfirm: { from: null, to: "server, machine-learning", diff: null, warning: null },
  });
  const started = await service.update("immich", { confirm: true }, null);
  if (!("jobId" in started)) throw new Error("expected a job");
  expect(jobStore.job(started.jobId)?.steps[0]).toMatchObject({
    stack: "immich",
    from: null,
    to: "server, machine-learning",
    services: ["server", "machine-learning"],
  });
  await jobs.idle();
  expect(jobStore.job(started.jobId)?.status).toBe("success");
  expect(puller.calls.map((c) => c.image)).toEqual([SERVER, ML]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "server", "machine-learning"]]);
});

test("needsConfirm of a selection is computed on the selection", async () => {
  await immichStack();
  await check();
  expect(detection.stacks().stacks[0]).toMatchObject({ major: true, needsConfirm: true });

  const response = await service.update("immich", { services: ["machine-learning"] }, null);
  if (!("jobId" in response)) throw new Error("expected a job");
  expect(jobStore.job(response.jobId)?.steps[0]).toMatchObject({
    stack: "immich",
    from: "1.0.0",
    to: "1.1.0",
    services: ["machine-learning"],
  });
  await jobs.idle();
  expect(jobStore.job(response.jobId)?.status).toBe("success");
  expect(puller.calls.map((c) => c.image)).toEqual([ML]);

  expect(await service.update("immich", { services: ["server"] }, null)).toEqual({
    needsConfirm: { from: "1.0.0", to: "2.0.0", diff: null, warning: null },
  });
});

test("a target changed by a check queued in between fails the step", async () => {
  const dir = await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  const release = gate();
  const response = await service.update("mealie", { confirm: true }, null);
  if (!("jobId" in response)) throw new Error("expected a job");
  changeStatus("mealie", (status) => ({ ...status, available: "v4.0.0", major: true, needsConfirm: true }));
  release();
  await jobs.idle();

  expect(jobStore.job(response.jobId)).toMatchObject({ status: "failed", steps: [{ status: "failed" }] });
  expect(jobStore.jobLog(response.jobId)).toContain(
    "la cible a changé depuis la demande (v3.5.0 → v4.0.0) : relancer la mise à jour",
  );
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
});

test("a queued sidecar update fails when the version variable gets a target", async () => {
  const sidecar = "postgres:16-alpine";
  await makeStack(
    "app",
    [
      {
        name: "app",
        image: "ghcr.io/acme/app:1.0.0",
        rawImage: "ghcr.io/acme/app:${APP_TAG}",
        pullPolicy: null,
        platform: null,
      },
      { name: "db", image: sidecar, rawImage: sidecar, pullPolicy: null, platform: null },
    ],
    { ".env": "APP_TAG=1.0.0\n" },
  );
  await writeFile(configPath, "stacks:\n  app:\n    version: { file: .env, variable: APP_TAG }\n");
  registry.tagsByRepository.set("acme/app", ["1.0.0"]);
  registry.digests.set("library/postgres:16-alpine", "sha256:new");
  docker.images.set(sidecar, { id: "old", repoDigests: ["postgres@sha256:old"], version: null, created: null });
  await check();
  const release = gate();
  const response = await service.update("app", {}, null);
  if (!("jobId" in response)) throw new Error("expected a job");
  expect(jobStore.job(response.jobId)?.steps[0]).toMatchObject({ services: ["db"] });
  changeStatus("app", (status) => ({ ...status, available: "1.1.0" }));
  release();
  await jobs.idle();

  expect(jobStore.job(response.jobId)?.status).toBe("failed");
  expect(jobStore.jobLog(response.jobId)).toContain(
    "la cible a changé depuis la demande (aucune → 1.1.0) : relancer la mise à jour",
  );
  expect(puller.calls).toEqual([]);
});

test("a queued update that now needs a confirmation fails the step", async () => {
  await immichStack();
  await check();
  const release = gate();
  const response = await service.update("immich", { services: ["machine-learning"] }, null);
  if (!("jobId" in response)) throw new Error("expected a job");
  await writeFile(configPath, "stacks:\n  immich:\n    confirm: true\n");
  release();
  await jobs.idle();

  expect(jobStore.job(response.jobId)?.status).toBe("failed");
  expect(jobStore.jobLog(response.jobId)).toContain(
    "une confirmation est maintenant nécessaire : relancer la mise à jour",
  );
  expect(puller.calls).toEqual([]);
});

test("a second queued update of a done stack succeeds with nothing left to do", async () => {
  await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  const prepare = vi.spyOn(moduleRef.get(VersionStrategy), "prepare");
  const release = gate();
  const first = await service.update("mealie", {}, null);
  const second = await service.update("mealie", {}, null);
  if (!("jobId" in first) || !("jobId" in second)) throw new Error("expected jobs");
  release();
  await jobs.idle();

  expect(jobStore.job(first.jobId)?.status).toBe("success");
  expect(jobStore.job(second.jobId)).toMatchObject({ status: "success", steps: [{ status: "success" }] });
  expect(jobStore.jobLog(second.jobId)).toEqual(["rien à faire : déjà à jour"]);
  expect(prepare).toHaveBeenCalledTimes(1);
});

test("a second queued update reached by the first succeeds even when the re-check found a newer version", async () => {
  const dir = await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  const pulled = puller.onPull;
  puller.onPull = (image) => {
    pulled(image);
    registry.tagsByRepository.set("mealie-recipes/mealie", ["v3.4.0", "v3.5.0", "v3.6.0"]);
  };
  const release = gate();
  const first = await service.update("mealie", {}, null);
  const second = await service.update("mealie", {}, null);
  if (!("jobId" in first) || !("jobId" in second)) throw new Error("expected jobs");
  release();
  await jobs.idle();

  expect(jobStore.job(first.jobId)?.status).toBe("success");
  expect(
    moduleRef
      .get(StackStatusStore)
      .stackStatuses()
      .find((s) => s.name === "mealie")?.available,
  ).toBe("v3.6.0");
  expect(jobStore.job(second.jobId)?.status).toBe("success");
  expect(jobStore.jobLog(second.jobId)).toEqual(["rien à faire : déjà à jour"]);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
});

test("a queued update whose re-check failed fails instead of passing for done", async () => {
  await mealieStack();
  await immichStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  const release = gate();
  const mealie = await service.update("mealie", {}, null);
  const immich = await service.update("immich", { services: ["machine-learning"] }, null);
  if (!("jobId" in mealie) || !("jobId" in immich)) throw new Error("expected jobs");
  changeStatus("mealie", (status) => ({ ...status, update: false, error: "registre injoignable" }));
  changeStatus("immich", (status) => ({
    ...status,
    services: status.services.map((s) =>
      s.name === "machine-learning" ? { ...s, update: false, error: "manifest unknown" } : s,
    ),
  }));
  release();
  await jobs.idle();

  expect(jobStore.job(mealie.jobId)?.status).toBe("failed");
  expect(jobStore.jobLog(mealie.jobId)).toEqual([
    "vérification en erreur : registre injoignable : relancer la mise à jour",
  ]);
  expect(jobStore.job(immich.jobId)?.status).toBe("failed");
  expect(jobStore.jobLog(immich.jobId)).toEqual([
    "vérification en erreur : manifest unknown : relancer la mise à jour",
  ]);
  expect(puller.calls).toEqual([]);
});

test("update-all leaves out a pull stack whose selectable images need a confirmation", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  webRunning();
  await immichStack();
  await check();
  // The stack-level values may come from a minor service; server's major bump still needs a confirmation.
  changeStatus("immich", (status) => ({ ...status, major: false, needsConfirm: false }));

  const job = await service.updateAll(null);
  expect(job.steps.map((s) => s.stack)).toEqual(["web"]);
  await jobs.idle();
  expect(puller.calls.map((c) => c.image)).toEqual([WEB]);
});

test("rollback while the stack has a queued or running job → 409", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  webRunning();
  await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  await service.update("web", {}, null);
  await jobs.idle();
  rollbacks.save({
    stack: "mealie",
    to: "v3.3.0",
    major: false,
    running: false,
    data: { kind: "version", file: ".env", variable: "VERSION", value: "v3.3.0" },
  });
  const conflict = (stack: string) =>
    new ConflictError(`Une tâche est déjà prévue pour ${stack}, attends qu'elle se termine`);

  const release = gate();
  // A job that names no stack (a check) does not block a rollback.
  const queued = await service.rollback("web", {}, null);
  expect(jobStore.job(queued.id)?.status).toBe("queued");
  await expect(service.rollback("web", {}, null)).rejects.toThrow(conflict("web"));
  await expect(service.rollback("web", { service: "web" }, null)).rejects.toThrow(conflict("web"));
  // A queued update-all names every stack it plans.
  await service.updateAll(null);
  await expect(service.rollback("mealie", {}, null)).rejects.toThrow(conflict("mealie"));
  release();
  await jobs.idle();

  const releaseRunning = gate([{ stack: "mealie", services: null }]);
  await expect(service.rollback("mealie", {}, null)).rejects.toBeInstanceOf(ConflictError);
  releaseRunning();
  await jobs.idle();
});

test("rollback of one service needs its point", async () => {
  await immichStack();
  await check();
  await service.update("immich", { confirm: true }, null);
  await jobs.idle();
  expect(rollbacks.points("immich").map((p) => p.service)).toEqual(["machine-learning", "server"]);

  await expect(service.rollback("immich", { service: "redis" }, null)).rejects.toThrow(
    new BadRequestError("Aucun retour arrière disponible pour immich/redis"),
  );
  const job = await service.rollback("immich", { service: "machine-learning" }, null);
  expect(job.steps[0]).toMatchObject({ stack: "immich", to: "1.0.0", services: ["machine-learning"] });
  await jobs.idle();
  expect(jobStore.job(job.id)?.status).toBe("success");
  expect(rollbacks.points("immich").map((p) => p.service)).toEqual(["server"]);
});

test("rollback without service takes every point", async () => {
  await immichStack();
  await check();
  await service.update("immich", { confirm: true }, null);
  await jobs.idle();

  const job = await service.rollback("immich", {}, null);
  expect(job.steps[0]).toMatchObject({ stack: "immich", to: "1.0.0, 1.0.0", services: ["machine-learning", "server"] });
  await jobs.idle();
  expect(jobStore.job(job.id)?.status).toBe("success");
  expect(rollbacks.points("immich")).toEqual([]);
});

test("update-all pins the planned targets", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  webRunning();
  await mealieStack();
  await writeFile(configPath, MEALIE_CONFIG);
  await check();
  const release = gate();
  const job = await service.updateAll(null);
  expect(job.steps).toEqual([
    { stack: "mealie", status: "pending", from: "v3.4.0", to: "v3.5.0" },
    { stack: "web", status: "pending", from: "1.0", to: "1.1", services: ["web"] },
  ]);
  // A check queued in between found a newer web image: web must not take it.
  changeStatus("web", (status) => ({
    ...status,
    services: status.services.map((s) => ({ ...s, available: "1.2" })),
  }));
  release();
  await jobs.idle();

  expect(jobStore.job(job.id)).toMatchObject({
    status: "failed",
    steps: [
      { stack: "mealie", status: "success" },
      { stack: "web", status: "failed" },
    ],
  });
  expect(jobStore.jobLog(job.id)).toContain(
    "la cible a changé depuis la demande (1.1 → 1.2) : relancer la mise à jour",
  );
  expect(puller.calls.map((c) => c.image)).toEqual([`${MEALIE}:v3.4.0`]);
});

test("a queued update fails when an earlier job failed on the stack, keeping the rollback point", async () => {
  // A failed health check leaves the new image running: tagging it now would replace the only way back.
  const failing = await testModule({
    database,
    docker,
    puller,
    registry,
    fetch: fetchFn,
    now: () => NOW,
    env: { root, configPath },
    wait: async () => {
      docker.containersByDir.set(join(root, "immich"), [
        { service: "server", state: "running", exitCode: 1, health: null, imageId: `${SERVER}-new` },
      ]);
      return { ok: false, problems: ["server : unhealthy"] };
    },
  });
  jobs = failing.get(JobRunner);
  jobStore = failing.get(JobStore);
  detection = failing.get(DetectionService);
  service = failing.get(UpdateService);
  await immichStack();
  await check();
  const release = gate();
  const first = await service.update("immich", { services: ["server"], confirm: true }, null);
  const second = await service.update("immich", { services: ["server"], confirm: true }, null);
  if (!("jobId" in first) || !("jobId" in second)) throw new Error("expected jobs");
  release();
  await jobs.idle();

  expect(jobStore.job(first.jobId)?.status).toBe("failed");
  expect(jobStore.job(second.jobId)?.status).toBe("failed");
  expect(jobStore.jobLog(second.jobId)).toContain(
    "une tâche précédente sur immich a échoué : vérifier la stack puis relancer la mise à jour",
  );
  expect(docker.tagCalls.filter((c) => c.target === "updater-rollback/immich-server:latest")).toHaveLength(1);
  expect(puller.calls.map((c) => c.image)).toEqual([SERVER]);
});

test("update-all and the stored status agree on a selectable stack with a major service", async () => {
  await immichStack();
  // The minor service first: the stack-level versions, and `major`, come from it.
  const dir = join(root, "immich");
  const services = docker.services.get(dir);
  if (!Array.isArray(services)) throw new Error("expected services");
  docker.services.set(dir, [...services].reverse());
  await check();
  const status = moduleRef
    .get(StackStatusStore)
    .stackStatuses()
    .find((s) => s.name === "immich")!;
  expect(status.major).toBe(false);
  expect(status.needsConfirm).toBe(true);
  await expect(service.updateAll(null)).rejects.toThrow(new BadRequestError("Aucune mise à jour à appliquer"));
});
