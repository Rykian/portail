import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackStatus } from "@portail/shared/updater-api";
import type { TestingModule } from "@nestjs/testing";
import { beforeEach, describe, expect, test } from "vitest";
import { stackConfig, type StackConfig, type UpdaterConfig } from "../config/config";
import { JobRunner } from "../jobs/job-runner";
import type { DiscoveredStack } from "../stacks/discovery";
import { RollbackStore } from "../stacks/rollback.store";
import { StackStatusStore } from "../stacks/stack-status.store";
import { FakeDocker, FakeRegistry, tempDir } from "../test/fakes";
import { testModule } from "../test/module";
import { DetectionService } from "./detection.service";

const NOW = new Date("2026-10-24T10:00:00.000Z");
let docker: FakeDocker;
let registry: FakeRegistry;
let moduleRef: TestingModule;
let detection: DetectionService;
let root: string;
let configPath: string;

beforeEach(async () => {
  docker = new FakeDocker();
  registry = new FakeRegistry();
  root = await tempDir();
  configPath = join(root, "config.yml");
  moduleRef = await testModule({ docker, registry, now: () => NOW, env: { root, configPath } });
  detection = moduleRef.get(DetectionService);
});

async function makeStack(name: string, env?: string): Promise<DiscoveredStack> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "compose.yml"), "services: {}\n");
  if (env !== undefined) await writeFile(join(dir, ".env"), env);
  return { name, dir, composeFile: "compose.yml" };
}

async function check() {
  detection.check(null);
  await moduleRef.get(JobRunner).idle();
}

const config = (extra: Partial<StackConfig> = {}): StackConfig => ({
  ...stackConfig({ exclude: [], stacks: {} }, "x"),
  ...extra,
});
const versionConfig = (variable = "VERSION", extra: Partial<StackConfig> = {}) =>
  config({ version: { file: ".env", variable }, ...extra });

describe("floating", () => {
  const ref = "lscr.io/linuxserver/x:latest";
  async function setup() {
    const stack = await makeStack("x");
    docker.services.set(stack.dir, [{ name: "web", image: ref, rawImage: ref }]);
    return stack;
  }

  test("new digest without labels gives the remote created date", async () => {
    const stack = await setup();
    docker.images.set(ref, {
      id: "i",
      repoDigests: ["lscr.io/linuxserver/x@sha256:old"],
      version: null,
      created: null,
    });
    registry.digests.set("linuxserver/x:latest", "sha256:new");
    registry.detailsByRef.set("linuxserver/x:latest", { version: null, created: "2026-10-01T00:00:00Z" });
    const status = await detection.checkStack(stack, config());
    expect(status.mode).toBe("pull");
    expect(status.services[0]).toMatchObject({
      kind: "floating",
      update: true,
      current: null,
      available: null,
      newImageDate: "2026-10-01T00:00:00Z",
    });
    expect(status.update).toBe(true);
    expect(status.button).toBe(true);
  });

  test("version labels on both sides give current and available", async () => {
    const stack = await setup();
    docker.images.set(ref, {
      id: "i",
      repoDigests: ["lscr.io/linuxserver/x@sha256:old"],
      version: "1.0",
      created: null,
    });
    registry.digests.set("linuxserver/x:latest", "sha256:new");
    registry.detailsByRef.set("linuxserver/x:latest", { version: "1.1", created: "2026-10-01T00:00:00Z" });
    const status = await detection.checkStack(stack, config());
    expect(status.services[0]).toMatchObject({ update: true, current: "1.0", available: "1.1" });
    expect(status.current).toBe("1.0");
    expect(status.available).toBe("1.1");
  });

  test("same digest is up to date and details is not called", async () => {
    const stack = await setup();
    docker.images.set(ref, {
      id: "i",
      repoDigests: ["lscr.io/linuxserver/x@sha256:same"],
      version: null,
      created: null,
    });
    registry.digests.set("linuxserver/x:latest", "sha256:same");
    const status = await detection.checkStack(stack, config());
    expect(status.services[0]?.update).toBe(false);
    expect(status.update).toBe(false);
    expect(registry.calls.some((c) => c.startsWith("details"))).toBe(false);
  });

  test("missing local image is a service error", async () => {
    const stack = await setup();
    const status = await detection.checkStack(stack, config());
    expect(status.services[0]).toMatchObject({ update: false, error: "image locale introuvable" });
  });
});

describe("version variable", () => {
  const raw = "ghcr.io/mealie-recipes/mealie:${VERSION}";
  async function setup(tags: string[]) {
    const stack = await makeStack("mealie", "VERSION=v3.4.0\n");
    docker.services.set(stack.dir, [{ name: "mealie", image: "ghcr.io/mealie-recipes/mealie:v3.4.0", rawImage: raw }]);
    registry.tagsByRepository.set("mealie-recipes/mealie", tags);
    return stack;
  }

  test("minor bump", async () => {
    const stack = await setup(["v3.4.0", "v3.5.0"]);
    const status = await detection.checkStack(stack, versionConfig());
    expect(status).toMatchObject({
      mode: "version",
      current: "v3.4.0",
      available: "v3.5.0",
      update: true,
      button: true,
      major: false,
      needsConfirm: false,
      error: null,
      checkedAt: NOW.toISOString(),
    });
    expect(status.services[0]).toMatchObject({ kind: "variable", current: "v3.4.0", available: "v3.5.0" });
  });

  test("major bump needs confirmation", async () => {
    const stack = await setup(["v3.5.0", "v4.0.0"]);
    const status = await detection.checkStack(stack, versionConfig());
    expect(status).toMatchObject({ available: "v4.0.0", major: true, needsConfirm: true });
  });

  test("confirm in config forces needsConfirm", async () => {
    const stack = await setup(["v3.5.0"]);
    const status = await detection.checkStack(stack, versionConfig("VERSION", { confirm: true }));
    expect(status.needsConfirm).toBe(true);
    expect(status.confirm).toBe(true);
  });
});

test("variable service error becomes a stack error", async () => {
  const stack = await makeStack("mealie", "VERSION=v3.4.0\n");
  docker.services.set(stack.dir, [{ name: "m", image: "ghcr.io/o/m:v3.4.0", rawImage: "ghcr.io/o/m:${VERSION}" }]);
  registry.errors.set("o/m", new Error("Registry responded 429"));
  const status = await detection.checkStack(stack, versionConfig());
  expect(status).toMatchObject({ error: "Registry responded 429", button: false });
});

test("unreadable version file becomes a stack error", async () => {
  const stack = await makeStack("direnv");
  await mkdir(join(stack.dir, ".env"));
  docker.services.set(stack.dir, []);
  const status = await detection.checkStack(stack, versionConfig());
  expect(status.error).not.toBeNull();
  expect(status.button).toBe(false);
});

test("variable kind matches ${VAR} and ${VAR:-x} but not a longer name", async () => {
  const stack = await makeStack("kinds", "VERSION=v1.0.0\n");
  docker.services.set(stack.dir, [
    { name: "a", image: "o/a:v1.0.0", rawImage: "o/a:${VERSION}" },
    { name: "b", image: "o/b:v1.0.0", rawImage: "o/b:${VERSION:-x}" },
    { name: "c", image: "o/c:v1.0.0", rawImage: "o/c:${VERSION_SUFFIX}" },
  ]);
  const status = await detection.checkStack(stack, versionConfig());
  expect(status.services.map((s) => s.kind)).toEqual(["variable", "variable", "literal"]);
});

test("Docker Hub library image compares digests", async () => {
  const stack = await makeStack("hub");
  docker.services.set(stack.dir, [{ name: "n", image: "nginx:latest", rawImage: "nginx:latest" }]);
  docker.images.set("nginx:latest", { id: "i", repoDigests: ["nginx@sha256:aaa"], version: null, created: null });
  registry.digests.set("library/nginx:latest", "sha256:aaa");
  expect((await detection.checkStack(stack, config())).services[0]?.update).toBe(false);
  registry.digests.set("library/nginx:latest", "sha256:bbb");
  expect((await detection.checkStack(stack, config())).services[0]?.update).toBe(true);
});

test("literal version has an update but no button", async () => {
  const stack = await makeStack("gate");
  docker.services.set(stack.dir, [{ name: "gate", image: "nginx:1.31.6-alpine", rawImage: "nginx:1.31.6-alpine" }]);
  registry.tagsByRepository.set("library/nginx", ["1.31.6-alpine", "1.31.7-alpine"]);
  const status = await detection.checkStack(stack, config());
  expect(status.services[0]).toMatchObject({
    kind: "literal",
    update: true,
    current: "1.31.6-alpine",
    available: "1.31.7-alpine",
  });
  expect(status.update).toBe(true);
  expect(status.button).toBe(false);
});

test("pinned digest is never checked", async () => {
  const stack = await makeStack("pin");
  const image = "ghcr.io/o/x@sha256:abc";
  docker.services.set(stack.dir, [{ name: "x", image, rawImage: image }]);
  const status = await detection.checkStack(stack, config());
  expect(status.services[0]).toMatchObject({ kind: "pinned", update: false });
  expect(registry.calls).toEqual([]);
  expect(status.update).toBe(false);
});

describe("authentik recipe", () => {
  const tags = ["2026.8.3", "2026.8.4", "2026.10.0", "2026.10.2"];
  async function setup(version: string) {
    const stack = await makeStack("authentik", `AUTHENTIK_TAG=${version}\n`);
    const raw = "ghcr.io/goauthentik/server:${AUTHENTIK_TAG:-2026.8.3}";
    docker.services.set(stack.dir, [{ name: "server", image: `ghcr.io/goauthentik/server:${version}`, rawImage: raw }]);
    registry.tagsByRepository.set("goauthentik/server", tags);
    return stack;
  }
  const recipeConfig = () => versionConfig("AUTHENTIK_TAG", { recipe: "authentik" });

  test("minor change needs confirmation", async () => {
    const status = await detection.checkStack(await setup("2026.8.4"), recipeConfig());
    expect(status).toMatchObject({ mode: "recipe", recipe: "authentik", available: "2026.10.2", needsConfirm: true });
  });

  test("patch change does not", async () => {
    const status = await detection.checkStack(await setup("2026.8.3"), recipeConfig());
    expect(status).toMatchObject({ available: "2026.8.4", needsConfirm: false });
  });
});

test("registry error on one service leaves the other checked", async () => {
  const stack = await makeStack("two");
  docker.services.set(stack.dir, [
    { name: "a", image: "ghcr.io/o/a:latest", rawImage: "ghcr.io/o/a:latest" },
    { name: "b", image: "ghcr.io/o/b:latest", rawImage: "ghcr.io/o/b:latest" },
  ]);
  docker.images.set("ghcr.io/o/a:latest", {
    id: "a",
    repoDigests: ["ghcr.io/o/a@sha256:1"],
    version: null,
    created: null,
  });
  docker.images.set("ghcr.io/o/b:latest", {
    id: "b",
    repoDigests: ["ghcr.io/o/b@sha256:1"],
    version: null,
    created: null,
  });
  registry.errors.set("o/a", new Error("Registry responded 429 for ghcr.io/o/a:latest"));
  registry.digests.set("o/b:latest", "sha256:2");
  const status = await detection.checkStack(stack, config());
  expect(status.services[0]).toMatchObject({ update: false, error: "Registry responded 429 for ghcr.io/o/a:latest" });
  expect(status.services[1]).toMatchObject({ update: true, error: null });
  expect(status.error).toBeNull();
  expect(status).toMatchObject({ update: true, button: true });
});

test("composeServices failure becomes a stack error", async () => {
  const stack = await makeStack("broken");
  docker.services.set(stack.dir, new Error("compose invalide"));
  const status = await detection.checkStack(stack, config());
  expect(status).toMatchObject({ error: "compose invalide", update: false, button: false, services: [] });
});

test("rollback state is exposed", async () => {
  const stack = await makeStack("rb");
  docker.services.set(stack.dir, []);
  moduleRef
    .get(RollbackStore)
    .save({ stack: "rb", to: "v1", major: false, running: true, data: { kind: "pull", services: [] } });
  const status = await detection.checkStack(stack, config());
  expect(status.rollback).toEqual({ to: "v1", major: false });
});

test("checkAll saves statuses and lastCheck, surviving a failing stack", async () => {
  const a = await makeStack("aaa");
  const b = await makeStack("bbb");
  docker.services.set(a.dir, new Error("boom"));
  docker.services.set(b.dir, [{ name: "x", image: "ghcr.io/o/x@sha256:abc", rawImage: "ghcr.io/o/x@sha256:abc" }]);
  const lines: string[] = [];
  const cfg: UpdaterConfig = { exclude: [], stacks: {} };
  const list = await detection.checkAll(cfg, (l) => lines.push(l));
  expect(list.map((s: StackStatus) => s.name)).toEqual(["aaa", "bbb"]);
  expect(list.every((s) => s.checkedAt === NOW.toISOString())).toBe(true);
  expect(moduleRef.get(StackStatusStore).getMeta("lastCheck")).toBe(NOW.toISOString());
  expect(lines).toHaveLength(2);
});

test("check stores the config error and keeps the previous config", async () => {
  const web = "lscr.io/linuxserver/web:latest";
  docker.services.set((await makeStack("web")).dir, [{ name: "web", image: web, rawImage: web }]);
  docker.services.set((await makeStack("skipped")).dir, []);
  await writeFile(configPath, "exclude: [skipped]\n");
  await check();
  expect(detection.stacks()).toMatchObject({ configError: null, lastCheck: NOW.toISOString(), runningJob: null });
  expect(detection.stacks().stacks.map((s) => s.name)).toEqual(["web"]);

  await writeFile(configPath, "exclude: 3\n");
  await check();
  expect(detection.stacks().configError).toEqual(expect.any(String));
  expect(detection.stacks().stacks.map((s) => s.name)).toEqual(["web"]);
});
