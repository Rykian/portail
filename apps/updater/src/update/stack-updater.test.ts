import type { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { ImageProgress, ServiceStatus, StackStatus } from "@portail/shared/updater-api";
import type { StackConfig } from "../config/config";
import { openDatabase } from "../database/database";
import type { ComposeService, ContainerState } from "../docker/docker";
import { type PullPoint, RollbackStore } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { AuthentikMinorStrategy } from "../strategies/authentik-minor.strategy";
import { PullStrategy, rollbackTag } from "../strategies/pull.strategy";
import { Strategies } from "../strategies/strategies";
import { VersionStrategy } from "../strategies/version.strategy";
import { FakeDocker, FakeImagePuller, tempDir } from "../test/fakes";
import type { WaitHealthy } from "./health";
import { StackUpdater } from "./stack-updater";

const running = (service: string, imageId: string): ContainerState => ({
  service,
  state: "running",
  exitCode: 0,
  health: null,
  imageId,
});

const composeService = (name: string, image: string, extra: Partial<ComposeService> = {}): ComposeService => ({
  name,
  image,
  rawImage: image,
  pullPolicy: null,
  platform: null,
  ...extra,
});

const serviceStatus = (name: string, image: string, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({
  name,
  image,
  kind: "floating",
  current: null,
  available: null,
  newImageDate: null,
  update: true,
  error: null,
  ...extra,
});

const APP = "stirling/app:latest";

const baseConfig: StackConfig = { confirm: false, last: false, before: [], beforeOnlyOnMajor: false };

const baseStatus: StackStatus = {
  name: "stirling",
  mode: "pull",
  confirm: false,
  last: false,
  recipe: null,
  services: [serviceStatus("app", APP)],
  update: true,
  button: true,
  current: null,
  available: null,
  major: false,
  needsConfirm: false,
  rollback: null,
  selectable: true,
  serviceRollbacks: [],
  error: null,
  checkedAt: null,
};

let docker: FakeDocker;
let puller: FakeImagePuller;
let db: Database;
let rollbacks: RollbackStore;
let dir: string;
let immichDir: string;
let logs: string[];
let progress: ImageProgress[];

type CtxOptions = { config?: Partial<StackConfig>; status?: Partial<StackStatus>; selection?: string[] | null };

function ctx(options: CtxOptions = {}): StackContext {
  return {
    stack: { name: "stirling", dir, composeFile: "compose.yml" },
    config: { ...baseConfig, ...options.config },
    status: { ...baseStatus, ...options.status },
    selection: options.selection ?? null,
    log: (line) => logs.push(line),
    progress: (p) => progress.push(p),
  };
}

function makeUpdater(wait: WaitHealthy = async () => ({ ok: true })): StackUpdater {
  const strategies = new Strategies(
    new PullStrategy(docker),
    new VersionStrategy(docker),
    new AuthentikMinorStrategy(fetch, docker),
  );
  return new StackUpdater(docker, puller, rollbacks, strategies, wait);
}

const IMMICH = {
  server: "ghcr.io/immich-app/immich-server:release",
  "machine-learning": "ghcr.io/immich-app/immich-machine-learning:release",
  redis: "docker.io/valkey/valkey:8.1.0",
  postgres: "ghcr.io/immich-app/postgres:14@sha256:abc",
};

/** Immich: `server` and `machine-learning` floating with an update, `redis` literal, `postgres` pinned; all running. */
const immichStatus = (services: { server?: Partial<ServiceStatus>; ml?: Partial<ServiceStatus> } = {}) => ({
  name: "immich",
  current: "v1.1.0",
  available: "v1.2.0",
  services: [
    serviceStatus("server", IMMICH.server, { current: "v1.1.0", available: "v1.2.0", ...services.server }),
    serviceStatus("machine-learning", IMMICH["machine-learning"], {
      current: "v1.1.0",
      available: "v1.2.0",
      ...services.ml,
    }),
    serviceStatus("redis", IMMICH.redis, { kind: "literal", update: false }),
    serviceStatus("postgres", IMMICH.postgres, { kind: "pinned", update: false }),
  ],
});

function immichCtx(options: CtxOptions = {}): StackContext {
  const base = ctx(options);
  return {
    ...base,
    stack: { name: "immich", dir: immichDir, composeFile: "compose.yml" },
    status: { ...base.status, ...immichStatus(), ...options.status },
  };
}

const point = (service: keyof typeof IMMICH, extra: Partial<PullPoint> = {}): PullPoint => ({
  stack: "immich",
  service,
  image: IMMICH[service],
  to: "v1.1.0",
  major: false,
  running: true,
  ...extra,
});

beforeEach(async () => {
  docker = new FakeDocker();
  puller = new FakeImagePuller();
  db = openDatabase(":memory:");
  rollbacks = new RollbackStore(db);
  dir = await tempDir();
  immichDir = await tempDir();
  logs = [];
  progress = [];
  docker.services.set(dir, [composeService("app", APP)]);
  docker.containersByDir.set(dir, [running("app", "sha256:old")]);
  docker.services.set(
    immichDir,
    Object.entries(IMMICH).map(([name, image]) => composeService(name, image)),
  );
  docker.containersByDir.set(
    immichDir,
    Object.keys(IMMICH).map((name) => running(name, `sha256:${name}`)),
  );
});

const versionConfig = { version: { file: ".env", variable: "VERSION" } };
const versionStatus = { mode: "version" as const, current: "v3.4.0", available: "v3.5.0" };

test("rollbackTag", () => {
  expect(rollbackTag("stirling", "app")).toBe("updater-rollback/stirling-app:latest");
});

test("pull mode tags, saves a point, downloads, ups the service", async () => {
  expect(await makeUpdater().update(ctx())).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "sha256:old", target: "updater-rollback/stirling-app:latest" }]);
  expect(puller.calls).toEqual([{ image: APP, platform: null }]);
  expect(docker.composeCalls).toEqual([{ dir, args: ["up", "-d", "--no-deps", "app"] }]);
  expect(rollbacks.get("stirling")).toBeNull();
  expect(rollbacks.points("stirling")).toEqual([
    { stack: "stirling", service: "app", image: APP, to: "l'image précédente", major: false, running: true },
  ]);
  expect(logs).toContain(`== téléchargement de ${APP}`);
});

test("pull mode removes points and rollback tags of services gone from the stack", async () => {
  const saved = { stack: "stirling", image: APP, to: "x", major: false, running: true };
  rollbacks.savePoint({ ...saved, service: "app" });
  rollbacks.savePoint({ ...saved, service: "old", image: "stirling/old:latest" });
  await makeUpdater().update(ctx());
  expect(docker.removeImageCalls).toEqual(["updater-rollback/stirling-old:latest"]);
  expect(rollbacks.points("stirling").map((p) => p.service)).toEqual(["app"]);
});

test("version mode rewrites the variable and saves the previous value", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
  expect(rollbacks.get("stirling")).toEqual({
    stack: "stirling",
    to: "v3.4.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "VERSION", value: "v3.4.0" },
  });
  expect(puller.calls).toEqual([{ image: APP, platform: null }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d"]]);
});

test("version mode with the variable missing fails before any change", async () => {
  await writeFile(join(dir, ".env"), "OTHER=1\n");
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("OTHER=1\n");
  expect(docker.composeCalls).toEqual([]);
  expect(puller.calls).toEqual([]);
  expect(rollbacks.get("stirling")).toBeNull();
});

test("a failing before command stops the update", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.shellExit = () => 1;
  const result = await makeUpdater().update(
    ctx({ config: { ...versionConfig, before: ["false"] }, status: versionStatus }),
  );
  expect(result).toBe("failed");
  expect(docker.shellCalls).toEqual([{ dir, command: "false" }]);
  expect(rollbacks.get("stirling")?.data).toMatchObject({ kind: "version", value: "v3.4.0" });
  expect(docker.composeCalls).toEqual([]);
  expect(puller.calls).toEqual([]);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
});

test("beforeOnlyOnMajor", async () => {
  const run = async (status: Partial<StackStatus>) => {
    docker.shellCalls = [];
    await makeUpdater().update(
      ctx({
        config: { before: ["echo hi"], beforeOnlyOnMajor: true },
        status: { current: "1", available: "2", ...status },
      }),
    );
    return docker.shellCalls.length;
  };
  expect(await run({ major: false })).toBe(0);
  expect(await run({ major: true })).toBe(1);
  expect(await run({ current: null })).toBe(1);
  expect(await run({ available: null })).toBe(1);
});

test("a download failure fails; version file already rewritten", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  puller.results.set(APP, new Error("manifest unknown"));
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
  expect(rollbacks.get("stirling")).not.toBeNull();
  expect(docker.composeCalls).toEqual([]);
  expect(logs).toContain("manifest unknown");
});

test("composeServices throwing fails without changes", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.services.set(dir, new Error("boom"));
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(docker.composeCalls).toEqual([]);
  expect(logs.join("\n")).toContain("boom");
});

test("unhealthy result fails and lists the problems", async () => {
  const result = await makeUpdater(async () => ({ ok: false, problems: ["app : unhealthy"] })).update(ctx());
  expect(result).toBe("failed");
  expect(logs).toContain("app : unhealthy");
});

test("rollback pull re-tags, ups, cleans up", async () => {
  const updater = makeUpdater();
  await updater.update(ctx());
  docker.tagCalls = [];
  docker.composeCalls = [];
  expect(await updater.rollback(ctx(), null)).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "updater-rollback/stirling-app:latest", target: APP }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "app"]]);
  expect(rollbacks.points("stirling")).toEqual([]);
  expect(docker.removeImageCalls).toEqual(["updater-rollback/stirling-app:latest"]);
});

test("rollback version restores the variable", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  const updater = makeUpdater();
  await updater.update(ctx({ config: versionConfig, status: versionStatus }));
  docker.composeCalls = [];
  expect(await updater.rollback(ctx({ config: versionConfig }), null)).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--pull", "missing"]]);
});

test("rollback recipe restores compose.yml and the variable", async () => {
  await writeFile(join(dir, ".env"), "AUTHENTIK_TAG=2026.10.1\n");
  await writeFile(join(dir, "compose.yml"), "new: true\n");
  rollbacks.save({
    stack: "stirling",
    to: "2026.8.3",
    major: false,
    running: true,
    data: { kind: "recipe", file: ".env", variable: "AUTHENTIK_TAG", value: "2026.8.3", compose: "old: true\n" },
  });
  expect(await makeUpdater().rollback(ctx(), null)).toBe("success");
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe("old: true\n");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.8.3\n");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--pull", "missing"]]);
});

test("rollback without saved state fails", async () => {
  expect(await makeUpdater().rollback(ctx(), null)).toBe("failed");
  expect(logs).toContain("aucun état de retour arrière pour stirling");
  expect(await makeUpdater().rollback(ctx(), "app")).toBe("failed");
  expect(logs).toContain("aucun état de retour arrière pour stirling/app");
});

test("a stopped container is not tagged", async () => {
  docker.containersByDir.set(dir, [{ ...running("app", "sha256:old"), state: "exited" }]);
  await makeUpdater().update(ctx());
  expect(docker.tagCalls).toEqual([]);
  expect(rollbacks.points("stirling")).toEqual([]);
});

test("pinned services are not tagged nor saved", async () => {
  docker.services.set(dir, [composeService("app", APP), composeService("db", "pg@sha256:abc")]);
  docker.containersByDir.set(dir, [running("app", "sha256:old"), running("db", "sha256:db")]);
  await makeUpdater().update(ctx({ selection: ["app", "db"] }));
  expect(docker.tagCalls.map((t) => t.target)).toEqual(["updater-rollback/stirling-app:latest"]);
  expect(rollbacks.points("stirling").map((p) => p.service)).toEqual(["app"]);
});

test("scaled services are saved once", async () => {
  docker.containersByDir.set(dir, [running("app", "sha256:old"), running("app", "sha256:old")]);
  await makeUpdater().update(ctx());
  expect(docker.tagCalls).toHaveLength(1);
  expect(rollbacks.points("stirling").map((p) => p.service)).toEqual(["app"]);
});

test("version mode with no variable target updates the floating sidecar like pull mode and leaves the variable alone", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.services.set(dir, [
    composeService("app", "stirling/app:v3.4.0", { rawImage: "stirling/app:${VERSION}" }),
    composeService("db", "postgres:16-alpine"),
  ]);
  docker.containersByDir.set(dir, [running("app", "sha256:app"), running("db", "sha256:db")]);
  rollbacks.save({
    stack: "stirling",
    to: "v3.3.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "VERSION", value: "v3.3.0" },
  });
  const status = {
    ...versionStatus,
    available: null,
    services: [
      serviceStatus("app", "stirling/app:v3.4.0", { kind: "variable", update: false }),
      serviceStatus("db", "postgres:16-alpine"),
    ],
  };
  expect(await makeUpdater().update(ctx({ config: versionConfig, status }))).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(puller.calls).toEqual([{ image: "postgres:16-alpine", platform: null }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "db"]]);
  expect(docker.tagCalls.map((t) => t.target)).toEqual(["updater-rollback/stirling-db:latest"]);
  expect(rollbacks.get("stirling")).toBeNull();
  expect(rollbacks.points("stirling")).toEqual([
    {
      stack: "stirling",
      service: "db",
      image: "postgres:16-alpine",
      to: "l'image précédente",
      major: false,
      running: true,
    },
  ]);
});

test("a stack with no running container is only downloaded and left stopped", async () => {
  docker.containersByDir.set(dir, [{ ...running("app", "sha256:old"), state: "exited" }]);
  let waited = false;
  const wait: WaitHealthy = async () => {
    waited = true;
    return { ok: true };
  };
  expect(await makeUpdater(wait).update(ctx())).toBe("success");
  expect(puller.calls).toEqual([{ image: APP, platform: null }]);
  expect(docker.composeCalls).toEqual([]);
  expect(waited).toBe(false);
  expect(logs).toContain("pile arrêtée : images téléchargées, pile laissée arrêtée");
});

test("a stopped stack in version mode gets the new version written, downloaded, and stays stopped", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.containersByDir.set(dir, []);
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
  expect(puller.calls).toEqual([{ image: APP, platform: null }]);
  expect(docker.composeCalls).toEqual([]);
});

test("version mode refuses a target that is not newer than the .env value, before any change", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.6.0\n");
  const previous = {
    stack: "stirling",
    to: "v3.3.0",
    major: false,
    running: true,
    data: { kind: "version" as const, file: ".env", variable: "VERSION", value: "v3.3.0" },
  };
  rollbacks.save(previous);
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(logs).toContain("la version v3.5.0 n'est pas plus récente que v3.6.0 déjà dans .env : mise à jour annulée");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.6.0\n");
  expect(docker.composeCalls).toEqual([]);
  expect(docker.shellCalls).toEqual([]);
  expect(rollbacks.get("stirling")).toEqual(previous);
});

test("version mode refuses a target equal to the .env value", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.5.0\n");
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(docker.composeCalls).toEqual([]);
});

test("rollback fails when a broken container does not recover", async () => {
  await makeUpdater().update(ctx());
  const restarting: ContainerState = { ...running("app", "sha256:new"), state: "restarting" };
  docker.containersByDir.set(dir, [restarting]);
  const wait: WaitHealthy = async (read, before) => {
    expect(before.map((c) => c.state)).toEqual(["running"]);
    const after = await read();
    return after.every((c) => c.state === "running") ? { ok: true } : { ok: false, problems: ["app : restarting"] };
  };
  docker.removeImageCalls = [];
  expect(await makeUpdater(wait).rollback(ctx(), null)).toBe("failed");
  expect(rollbacks.points("stirling")).toHaveLength(1);
  expect(docker.removeImageCalls).toEqual([]);
});

test("a crash-looping stack is updated, started and health-checked as running", async () => {
  docker.containersByDir.set(dir, [{ ...running("app", "sha256:old"), state: "restarting" }]);
  let expected: string[] = [];
  const wait: WaitHealthy = async (_read, before) => {
    expected = before.map((c) => c.state);
    return { ok: true };
  };
  expect(await makeUpdater(wait).update(ctx())).toBe("success");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "app"]]);
  expect(expected).toEqual(["running"]);
  expect(docker.tagCalls.map((t) => t.target)).toEqual(["updater-rollback/stirling-app:latest"]);
  expect(rollbacks.points("stirling")).toMatchObject([{ running: true }]);
});

test("the rollback state records the major bump of the update", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  const status = { ...versionStatus, available: "v4.0.0", major: true };
  await makeUpdater().update(ctx({ config: versionConfig, status }));
  expect(rollbacks.get("stirling")).toMatchObject({ major: true, running: true });
});

test("rolling back a stack updated while stopped restores the version and leaves it stopped", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.containersByDir.set(dir, []);
  await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }));
  expect(rollbacks.get("stirling")).toMatchObject({ running: false });
  docker.composeCalls = [];
  let waited = false;
  const wait: WaitHealthy = async () => {
    waited = true;
    return { ok: true };
  };
  expect(await makeUpdater(wait).rollback(ctx({ config: versionConfig }), null)).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(docker.composeCalls).toEqual([]);
  expect(waited).toBe(false);
  expect(rollbacks.get("stirling")).toBeNull();
  expect(logs).toContain("pile arrêtée avant la mise à jour : retour arrière fait, pile laissée arrêtée");
});

test("a version stack whose version config disappeared fails before any change", async () => {
  expect(await makeUpdater().update(ctx({ status: { mode: "version", available: null } }))).toBe("failed");
  expect(logs).toContain("configuration de version absente");
  expect(docker.composeCalls).toEqual([]);
  expect(rollbacks.get("stirling")).toBeNull();
});

test.each([
  {
    kind: "version",
    json: '{"stack":"stirling","to":"v3.4.0","major":false,"running":true,"data":{"kind":"version","file":".env","variable":"VERSION","value":"v3.4.0"}}',
  },
  {
    kind: "recipe",
    json: '{"stack":"stirling","to":"v3.4.0","major":true,"running":true,"data":{"kind":"recipe","file":".env","variable":"VERSION","value":"v3.4.0","compose":"services: {old: {}}\\n"}}',
  },
])("rollbacks stored before the refactor restore through their strategy ($kind)", async ({ kind, json }) => {
  await writeFile(join(dir, ".env"), "VERSION=v3.5.0\n");
  if (kind === "recipe") await writeFile(join(dir, "compose.yml"), "services: {new: {}}\n");
  db.query("INSERT INTO rollbacks (stack, json) VALUES (?, ?)").run("stirling", json);
  expect(await makeUpdater().rollback(ctx(), null)).toBe("success");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--pull", "missing"]]);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  if (kind === "recipe") expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe("services: {old: {}}\n");
  expect(rollbacks.get("stirling")).toBeNull();
});

test("a selection tags, pulls and recreates only the selected services", async () => {
  expect(await makeUpdater().update(immichCtx({ selection: ["server"] }))).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "sha256:server", target: "updater-rollback/immich-server:latest" }]);
  expect(puller.calls).toEqual([{ image: IMMICH.server, platform: null }]);
  expect(docker.composeCalls).toEqual([{ dir: immichDir, args: ["up", "-d", "--no-deps", "server"] }]);
  expect(rollbacks.points("immich")).toEqual([point("server")]);
  expect(rollbacks.get("immich")).toBeNull();
});

test("major and before follow the selection", async () => {
  const config = { beforeOnlyOnMajor: true, before: ["backup"] };
  const status = {
    ...immichStatus({ server: { current: "v1", available: "v2" } }),
    // The stack-level values come from machine-learning: not a major bump.
    current: "v1.1",
    available: "v1.2",
    major: false,
  };
  expect(await makeUpdater().update(immichCtx({ config, status, selection: ["server"] }))).toBe("success");
  expect(docker.shellCalls).toEqual([{ dir: immichDir, command: "backup" }]);
  expect(rollbacks.points("immich")).toEqual([point("server", { to: "v1", major: true })]);

  docker.shellCalls = [];
  const majorStack = { ...status, current: "v1", available: "v2", major: true };
  await makeUpdater().update(immichCtx({ config, status: majorStack, selection: ["machine-learning"] }));
  expect(docker.shellCalls).toEqual([]);
  expect(rollbacks.points("immich")).toContainEqual(point("machine-learning", { major: false }));
});

test("progress is reported per image", async () => {
  puller.progressSteps.set(IMMICH.server, [
    [10, 100],
    [100, 100],
  ]);
  puller.results.set(IMMICH["machine-learning"], "up-to-date");
  await makeUpdater().update(immichCtx({ selection: ["server", "machine-learning"] }));
  const server = { stack: "immich", service: "server", image: IMMICH.server };
  const ml = { stack: "immich", service: "machine-learning", image: IMMICH["machine-learning"] };
  expect(progress).toEqual([
    { ...server, downloaded: 10, total: 100, state: "downloading" },
    { ...server, downloaded: 100, total: 100, state: "downloading" },
    { ...server, downloaded: 100, total: 100, state: "done" },
    { ...ml, downloaded: 0, total: 0, state: "up-to-date" },
  ]);
  const downloadLines = logs.filter((line) => line.includes("immich-app/immich-"));
  expect(downloadLines).toEqual([
    `== téléchargement de ${IMMICH.server}`,
    `${IMMICH.server} téléchargée`,
    `== téléchargement de ${IMMICH["machine-learning"]}`,
    `${IMMICH["machine-learning"]} déjà à jour`,
  ]);
});

test("version update pulls every image except pull_policy build/never, passes platform, ups the whole stack", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  // Images resolve from the .env file, as `docker compose config` does: the download must see the new version.
  docker.composeServices = async () => {
    const version = (await readFile(join(dir, ".env"), "utf8")).trim().split("=")[1];
    return [
      composeService("app", `stirling/app:${version}`, { platform: "linux/arm64" }),
      composeService("built", "stirling/built:local", { pullPolicy: "build" }),
      composeService("local", "stirling/local:dev", { pullPolicy: "never" }),
      composeService("db", "postgres:16.4", { pullPolicy: "always" }),
    ];
  };
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("success");
  expect(puller.calls).toEqual([
    { image: "stirling/app:v3.5.0", platform: "linux/arm64" },
    { image: "postgres:16.4", platform: null },
  ]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d"]]);
});

test("a pull failure fails the update before up", async () => {
  puller.results.set(IMMICH.server, new Error("manifest unknown"));
  expect(await makeUpdater().update(immichCtx({ selection: ["server"] }))).toBe("failed");
  expect(docker.composeCalls).toEqual([]);
  expect(logs).toContain("manifest unknown");
  expect(progress).toEqual([]);
  // The rollback point was saved before anything changed.
  expect(rollbacks.points("immich")).toEqual([point("server")]);
});

test("a stopped stack downloads and stays stopped", async () => {
  docker.containersByDir.set(
    immichDir,
    Object.keys(IMMICH).map((name) => ({ ...running(name, `sha256:${name}`), state: "exited" as const })),
  );
  let waited = false;
  const wait: WaitHealthy = async () => {
    waited = true;
    return { ok: true };
  };
  expect(await makeUpdater(wait).update(immichCtx({ selection: ["server"] }))).toBe("success");
  expect(puller.calls).toEqual([{ image: IMMICH.server, platform: null }]);
  expect(docker.composeCalls).toEqual([]);
  expect(waited).toBe(false);
  expect(logs).toContain("pile arrêtée : images téléchargées, pile laissée arrêtée");
});

test("rollback of one service retags it, ups it alone, checks the whole stack, drops its point", async () => {
  rollbacks.savePoint(point("server"));
  rollbacks.savePoint(point("machine-learning"));
  let checked: string[] = [];
  const wait: WaitHealthy = async (_read, before) => {
    checked = before.map((c) => c.service);
    return { ok: true };
  };
  expect(await makeUpdater(wait).rollback(immichCtx(), "server")).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "updater-rollback/immich-server:latest", target: IMMICH.server }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "server"]]);
  expect(checked).toEqual(Object.keys(IMMICH));
  expect(docker.removeImageCalls).toEqual(["updater-rollback/immich-server:latest"]);
  expect(rollbacks.points("immich")).toEqual([point("machine-learning")]);
});

test("rollback of all points ups only those that were running, in one up", async () => {
  rollbacks.savePoint(point("server", { running: true }));
  rollbacks.savePoint(point("machine-learning", { running: false }));
  expect(await makeUpdater().rollback(immichCtx(), null)).toBe("success");
  expect(docker.tagCalls.map((t) => t.target).sort()).toEqual([IMMICH["machine-learning"], IMMICH.server]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "server"]]);
  expect(docker.removeImageCalls.sort()).toEqual([
    "updater-rollback/immich-machine-learning:latest",
    "updater-rollback/immich-server:latest",
  ]);
  expect(rollbacks.points("immich")).toEqual([]);
});

test("a point whose service left the compose file is skipped on rollback and dropped on the next update", async () => {
  docker.services.set(immichDir, [
    composeService("server", IMMICH.server),
    composeService("redis", IMMICH.redis),
    composeService("postgres", IMMICH.postgres),
  ]);
  rollbacks.savePoint(point("server"));
  rollbacks.savePoint(point("machine-learning"));
  expect(await makeUpdater().rollback(immichCtx(), null)).toBe("success");
  expect(logs).toContain("machine-learning n'est plus dans la stack : ignoré");
  expect(docker.tagCalls.map((t) => t.target)).toEqual([IMMICH.server]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "server"]]);
  expect(rollbacks.points("immich")).toEqual([]);

  rollbacks.savePoint(point("machine-learning"));
  docker.removeImageCalls = [];
  expect(await makeUpdater().update(immichCtx({ selection: ["server"] }))).toBe("success");
  expect(docker.removeImageCalls).toEqual(["updater-rollback/immich-machine-learning:latest"]);
  expect(rollbacks.points("immich")).toEqual([point("server")]);
});

test("a version update replaces the pull points of the stack, and a pull update drops a version rollback", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  rollbacks.savePoint({ stack: "stirling", service: "app", image: APP, to: "x", major: false, running: true });
  expect(await makeUpdater().update(ctx({ config: versionConfig, status: versionStatus }))).toBe("success");
  expect(docker.removeImageCalls).toEqual(["updater-rollback/stirling-app:latest"]);
  expect(rollbacks.points("stirling")).toEqual([]);
  expect(rollbacks.get("stirling")).toMatchObject({ data: { kind: "version", value: "v3.4.0" } });

  expect(await makeUpdater().update(ctx({ selection: ["app"] }))).toBe("success");
  expect(rollbacks.get("stirling")).toBeNull();
  expect(rollbacks.points("stirling").map((p) => p.service)).toEqual(["app"]);
});

test("rollbacks stored before the change still restore", async () => {
  db.query("INSERT INTO rollbacks (stack, json) VALUES (?, ?)").run(
    "immich",
    JSON.stringify({
      stack: "immich",
      to: "l'image précédente",
      major: false,
      running: true,
      data: {
        kind: "pull",
        services: [
          { service: "server", image: IMMICH.server },
          { service: "machine-learning", image: IMMICH["machine-learning"] },
        ],
      },
    }),
  );
  rollbacks.migrateLegacy();
  expect(await makeUpdater().rollback(immichCtx(), null)).toBe("success");
  expect(docker.tagCalls).toEqual([
    { source: rollbackTag("immich", "machine-learning"), target: IMMICH["machine-learning"] },
    { source: rollbackTag("immich", "server"), target: IMMICH.server },
  ]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--no-deps", "machine-learning", "server"]]);
  expect(rollbacks.points("immich")).toEqual([]);
  expect(rollbacks.get("immich")).toBeNull();
});
