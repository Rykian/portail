import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createConfigLoader } from "./config";
import type { ComposeService } from "./docker";
import { BusyError, JobRunner } from "./jobs";
import { BadRequestError, NotFoundError, UpdaterService } from "./service";
import { Store } from "./store";
import { FakeDocker, FakeRegistry, tempDir } from "./test/fakes";

const NOW = new Date("2026-10-24T10:00:00.000Z");
const WARNING =
  "Ce service migre peut-être sa base au démarrage : le retour arrière peut échouer, la vraie sauvegarde est le vzdump.";
const LOCAL_MODIFICATIONS = "Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml";
const upstream08 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.8.4}\n    restart: always\n";
const upstream10 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.10.2}\n    restart: unless-stopped\n";

let root: string;
let configPath: string;
let docker: FakeDocker;
let registry: FakeRegistry;
let store: Store;
let jobs: JobRunner;
let service: UpdaterService;

const fetchFn = (async (url: string) =>
  new Response(url.includes("2026.10") ? upstream10 : upstream08, { status: 200 })) as unknown as typeof fetch;

beforeEach(async () => {
  root = await tempDir();
  configPath = join(root, "config.yml");
  docker = new FakeDocker();
  registry = new FakeRegistry();
  store = new Store(new Database(":memory:"));
  jobs = new JobRunner(store, () => NOW);
  service = new UpdaterService({
    root,
    loadConfig: createConfigLoader(configPath),
    docker,
    registry,
    store,
    jobs,
    now: () => NOW,
    fetch: fetchFn,
  });
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
  service.check(null);
  await jobs.idle();
}

const WEB = "lscr.io/linuxserver/web:latest";

/** A floating-tag stack whose `docker compose pull` brings the new image. */
async function floatingStack(labels: { local: string | null; remote: string | null }) {
  await makeStack("web", [{ name: "web", image: WEB, rawImage: WEB }]);
  docker.images.set(WEB, {
    id: "old",
    repoDigests: ["lscr.io/linuxserver/web@sha256:old"],
    version: labels.local,
    created: null,
  });
  registry.digests.set("linuxserver/web:latest", "sha256:new");
  registry.detailsByRef.set("linuxserver/web:latest", { version: labels.remote, created: "2026-10-01T00:00:00Z" });
  docker.composeExit = (args) => {
    if (args[0] === "pull") {
      docker.images.set(WEB, {
        id: "new",
        repoDigests: ["lscr.io/linuxserver/web@sha256:new"],
        version: labels.remote,
        created: null,
      });
    }
    return 0;
  };
}

async function authentikStack(compose: string) {
  const image = "ghcr.io/goauthentik/server:2026.8.4";
  await makeStack(
    "authentik",
    [{ name: "server", image, rawImage: "ghcr.io/goauthentik/server:${AUTHENTIK_TAG:-2026.8.4}" }],
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
  expect(service.history(null).jobs.map((job) => job.kind)).toEqual(["check"]);

  const started = await service.update("web", { confirm: true }, "a@b.c");
  expect(started).toEqual({ jobId: expect.any(Number) });
  await jobs.idle();
});

test("a successful update re-checks the stack and records from/to on the step", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  await check();
  const response = await service.update("web", {}, "a@b.c");
  if (!("jobId" in response)) throw new Error("expected a job");
  expect(service.job(response.jobId)?.steps[0]).toMatchObject({ stack: "web", from: "1.0", to: "1.1" });
  await jobs.idle();

  const job = service.job(response.jobId);
  expect(job).toMatchObject({ kind: "update", user: "a@b.c", status: "success" });
  expect(job?.steps[0]).toEqual({ stack: "web", status: "success", from: "1.0", to: "1.1" });
  const web = service.stacks().stacks.find((s) => s.name === "web");
  expect(web).toMatchObject({ update: false, rollback: { to: "1.0" } });
});

test("pull mode without version: rollback goes to « l'image précédente »", async () => {
  await floatingStack({ local: null, remote: null });
  await check();
  await service.update("web", {}, null);
  await jobs.idle();
  expect(service.stacks().stacks[0]).toMatchObject({ update: false, rollback: { to: "l'image précédente" } });
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
  const failing = new UpdaterService({
    root,
    loadConfig: createConfigLoader(configPath),
    docker,
    registry,
    store,
    jobs,
    now: () => NOW,
    fetch: (async () => {
      throw new Error("réseau indisponible");
    }) as unknown as typeof fetch,
  });
  await expect(failing.update("authentik", {}, null)).rejects.toThrow(new BadRequestError("réseau indisponible"));
});

test("update without button, unknown stack, busy", async () => {
  await makeStack("lit", [{ name: "db", image: "postgres:16.1.0", rawImage: "postgres:16.1.0" }]);
  registry.tagsByRepository.set("library/postgres", ["16.1.0", "16.2.0"]);
  await check();
  expect(service.stacks().stacks[0]).toMatchObject({ update: true, button: false });
  await expect(service.update("lit", {}, null)).rejects.toBeInstanceOf(BadRequestError);
  await expect(service.update("nope", {}, null)).rejects.toBeInstanceOf(NotFoundError);

  await floatingStack({ local: "1.0", remote: "1.1" });
  await check();
  let release = () => {};
  jobs.start(
    { kind: "check", user: null, steps: [] },
    () => new Promise((resolve) => (release = () => resolve("success"))),
  );
  await expect(service.update("web", {}, null)).rejects.toBeInstanceOf(BusyError);
  release();
  await jobs.idle();
});

test("rollback needs a rollback state, then restores and re-checks", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  await check();
  await expect(service.rollback("web", null)).rejects.toBeInstanceOf(BadRequestError);
  await expect(service.rollback("nope", null)).rejects.toBeInstanceOf(NotFoundError);
  await service.update("web", {}, null);
  await jobs.idle();

  const job = await service.rollback("web", "a@b.c");
  expect(job.kind).toBe("rollback");
  expect(job.steps[0]).toMatchObject({ stack: "web", to: "1.0" });
  await jobs.idle();
  expect(service.job(job.id)?.status).toBe("success");
  expect(service.stacks().stacks[0]?.rollback).toBeNull();
});

test("updateAll runs the planned stacks, refuses when nothing to do", async () => {
  await floatingStack({ local: "1.0", remote: "1.1" });
  expect(() => service.updateAll(null)).toThrow(new BadRequestError("Aucune mise à jour à appliquer"));
  await check();
  const job = service.updateAll("a@b.c");
  expect(job.kind).toBe("update-all");
  expect(job.steps).toEqual([{ stack: "web", status: "pending", from: "1.0", to: "1.1" }]);
  await jobs.idle();
  expect(service.job(job.id)).toMatchObject({ status: "success", steps: [{ status: "success" }] });
  expect(service.stacks().stacks[0]?.update).toBe(false);
});

test("check stores the config error and keeps the previous config", async () => {
  await makeStack("web", [{ name: "web", image: WEB, rawImage: WEB }]);
  await makeStack("skipped", []);
  await writeFile(configPath, "exclude: [skipped]\n");
  await check();
  expect(service.stacks()).toMatchObject({ configError: null, lastCheck: NOW.toISOString(), runningJob: null });
  expect(service.stacks().stacks.map((s) => s.name)).toEqual(["web"]);

  await writeFile(configPath, "exclude: 3\n");
  await check();
  expect(service.stacks().configError).toEqual(expect.any(String));
  expect(service.stacks().stacks.map((s) => s.name)).toEqual(["web"]);
});
