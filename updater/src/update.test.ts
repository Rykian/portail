import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { StackStatus } from "@shared/updater-api";
import type { StackConfig } from "./config";
import type { ContainerState } from "./docker";
import { Store } from "./store";
import { FakeDocker, tempDir } from "./test/fakes";
import { rollbackStack, rollbackTag, updateStack, type StackContext } from "./update";

const running = (service: string, imageId: string): ContainerState => ({
  service,
  state: "running",
  exitCode: 0,
  health: null,
  imageId,
});

const baseConfig: StackConfig = { confirm: false, last: false, before: [], beforeOnlyOnMajor: false };

const baseStatus: StackStatus = {
  name: "stirling",
  mode: "pull",
  confirm: false,
  last: false,
  recipe: null,
  services: [],
  update: true,
  button: true,
  current: null,
  available: null,
  major: false,
  needsConfirm: false,
  rollback: null,
  error: null,
  checkedAt: null,
};

let docker: FakeDocker;
let store: Store;
let dir: string;
let logs: string[];

async function ctx(
  options: { config?: Partial<StackConfig>; status?: Partial<StackStatus>; wait?: StackContext["wait"] } = {},
): Promise<StackContext> {
  return {
    stack: { name: "stirling", dir, composeFile: "compose.yml" },
    config: { ...baseConfig, ...options.config },
    status: { ...baseStatus, ...options.status },
    docker,
    store,
    log: (line) => logs.push(line),
    wait: options.wait ?? (async () => ({ ok: true })),
  };
}

beforeEach(async () => {
  docker = new FakeDocker();
  store = new Store(new Database(":memory:"));
  dir = await tempDir();
  logs = [];
  docker.services.set(dir, [{ name: "app", image: "stirling/app:latest", rawImage: "stirling/app:latest" }]);
  docker.containersByProject.set("stirling", [running("app", "sha256:old")]);
});

const versionConfig = { version: { file: ".env", variable: "VERSION" } };
const versionStatus = { mode: "version" as const, current: "v3.4.0", available: "v3.5.0" };

test("rollbackTag", () => {
  expect(rollbackTag("stirling", "app")).toBe("updater-rollback/stirling-app:latest");
});

test("pull mode tags, saves rollback, pulls, ups", async () => {
  expect(await updateStack(await ctx())).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "sha256:old", target: "updater-rollback/stirling-app:latest" }]);
  expect(docker.composeCalls).toEqual([
    { dir, args: ["pull"] },
    { dir, args: ["up", "-d"] },
  ]);
  expect(store.rollback("stirling")).toEqual({
    stack: "stirling",
    to: "l'image précédente",
    data: { kind: "pull", services: [{ service: "app", image: "stirling/app:latest" }] },
  });
  expect(logs).toContain("== docker compose pull");
});

test("pull mode removes rollback tags of services gone from the stack", async () => {
  store.saveRollback({
    stack: "stirling",
    to: "x",
    data: {
      kind: "pull",
      services: [
        { service: "app", image: "stirling/app:latest" },
        { service: "old", image: "stirling/old:latest" },
      ],
    },
  });
  await updateStack(await ctx());
  expect(docker.removeImageCalls).toEqual(["updater-rollback/stirling-old:latest"]);
});

test("version mode rewrites the variable and saves the previous value", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  expect(await updateStack(await ctx({ config: versionConfig, status: versionStatus }))).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
  expect(store.rollback("stirling")).toEqual({
    stack: "stirling",
    to: "v3.4.0",
    data: { kind: "version", file: ".env", variable: "VERSION", value: "v3.4.0" },
  });
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["pull"], ["up", "-d"]]);
});

test("version mode with the variable missing fails before any change", async () => {
  await writeFile(join(dir, ".env"), "OTHER=1\n");
  expect(await updateStack(await ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("OTHER=1\n");
  expect(docker.composeCalls).toEqual([]);
  expect(store.rollback("stirling")).toBeNull();
});

test("a failing before command stops the update", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.shellExit = () => 1;
  const result = await updateStack(
    await ctx({ config: { ...versionConfig, before: ["false"] }, status: versionStatus }),
  );
  expect(result).toBe("failed");
  expect(docker.shellCalls).toEqual([{ dir, command: "false" }]);
  expect(docker.composeCalls).toEqual([]);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
});

test("beforeOnlyOnMajor", async () => {
  const run = async (status: Partial<StackStatus>) => {
    docker.shellCalls = [];
    await updateStack(
      await ctx({
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

test("compose pull failure fails; version file already rewritten", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.composeExit = (args) => (args[0] === "pull" ? 1 : 0);
  expect(await updateStack(await ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.5.0\n");
  expect(store.rollback("stirling")).not.toBeNull();
  expect(docker.composeCalls).toHaveLength(1);
  expect(logs).toContain("docker compose pull a échoué (code 1)");
});

test("composeServices throwing fails without changes", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  docker.services.set(dir, new Error("boom"));
  expect(await updateStack(await ctx({ config: versionConfig, status: versionStatus }))).toBe("failed");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(docker.composeCalls).toEqual([]);
  expect(logs.join("\n")).toContain("boom");
});

test("unhealthy result fails and lists the problems", async () => {
  const result = await updateStack(await ctx({ wait: async () => ({ ok: false, problems: ["app : unhealthy"] }) }));
  expect(result).toBe("failed");
  expect(logs).toContain("app : unhealthy");
});

test("rollback pull re-tags, ups, cleans up", async () => {
  await updateStack(await ctx());
  docker.tagCalls = [];
  docker.composeCalls = [];
  expect(await rollbackStack(await ctx())).toBe("success");
  expect(docker.tagCalls).toEqual([{ source: "updater-rollback/stirling-app:latest", target: "stirling/app:latest" }]);
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d"]]);
  expect(store.rollback("stirling")).toBeNull();
  expect(docker.removeImageCalls).toEqual(["updater-rollback/stirling-app:latest"]);
});

test("rollback version restores the variable", async () => {
  await writeFile(join(dir, ".env"), "VERSION=v3.4.0\n");
  await updateStack(await ctx({ config: versionConfig, status: versionStatus }));
  docker.composeCalls = [];
  expect(await rollbackStack(await ctx({ config: versionConfig }))).toBe("success");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("VERSION=v3.4.0\n");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--pull", "missing"]]);
});

test("rollback recipe restores compose.yml and the variable", async () => {
  await writeFile(join(dir, ".env"), "AUTHENTIK_TAG=2026.10.1\n");
  await writeFile(join(dir, "compose.yml"), "new: true\n");
  store.saveRollback({
    stack: "stirling",
    to: "2026.8.3",
    data: { kind: "recipe", file: ".env", variable: "AUTHENTIK_TAG", value: "2026.8.3", compose: "old: true\n" },
  });
  expect(await rollbackStack(await ctx())).toBe("success");
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe("old: true\n");
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.8.3\n");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["up", "-d", "--pull", "missing"]]);
});

test("rollback without saved state fails", async () => {
  expect(await rollbackStack(await ctx())).toBe("failed");
  expect(logs).toContain("aucun état de retour arrière pour stirling");
});
