import { Database } from "bun:sqlite";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import type { StackStatus } from "@shared/updater-api";
import { authentikMinorUpdate, authentikPreview, normalizeCompose, upstreamComposeUrl } from "./authentik";
import { Store } from "./store";
import { FakeDocker, tempDir } from "./test/fakes";
import type { StackContext } from "./update";

const upstream08 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.8.4}\n    restart: always\n";
const upstream10 = "services:\n  server:\n    image: x:${AUTHENTIK_TAG:-2026.10.2}\n    restart: unless-stopped\n";
const localError = "Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml";

const status: StackStatus = {
  name: "authentik",
  mode: "recipe",
  confirm: true,
  last: false,
  recipe: "authentik",
  services: [],
  update: true,
  button: true,
  current: "2026.8.4",
  available: "2026.10.2",
  major: false,
  needsConfirm: true,
  rollback: null,
  error: null,
  checkedAt: null,
};

let docker: FakeDocker;
let store: Store;
let dir: string;
let logs: string[];
let requested: string[];
let statuses: Record<string, number>;
const localCompose = upstream08.replace("2026.8.4", "2026.8.1").replaceAll("\n", "\r\n");

const fetchFn = (async (url: string) => {
  requested.push(url);
  const code = statuses[url] ?? 200;
  const body = url.includes("2026.10") ? upstream10 : upstream08;
  return new Response(code === 200 ? body : "nope", { status: code });
}) as unknown as typeof fetch;

function ctx(config: Partial<StackContext["config"]> = {}): StackContext {
  return {
    stack: { name: "authentik", dir, composeFile: "compose.yml" },
    config: {
      confirm: true,
      last: false,
      before: [],
      beforeOnlyOnMajor: false,
      recipe: "authentik",
      version: { file: ".env", variable: "AUTHENTIK_TAG" },
      ...config,
    },
    status,
    docker,
    store,
    log: (line) => logs.push(line),
    wait: async () => ({ ok: true }),
  };
}

beforeEach(async () => {
  docker = new FakeDocker();
  store = new Store(new Database(":memory:"));
  dir = await tempDir();
  logs = [];
  requested = [];
  statuses = {};
  docker.containersByProject.set("authentik", [
    { service: "server", state: "running", exitCode: 0, health: null, imageId: "sha256:old" },
  ]);
  await writeFile(join(dir, "compose.yml"), localCompose);
  await writeFile(join(dir, ".env"), "AUTHENTIK_TAG=2026.8.4\n");
});

test("upstreamComposeUrl", () => {
  expect(upstreamComposeUrl("2026.10")).toBe("https://goauthentik.io/version/2026.10/lifecycle/container/compose.yml");
});

test("normalizeCompose drops CR and the tag default", () => {
  expect(normalizeCompose("a: ${AUTHENTIK_TAG:-2026.8.4}\r\nb: ${OTHER:-x}\r\n")).toBe(
    "a: ${AUTHENTIK_TAG}\nb: ${OTHER:-x}\n",
  );
});

test("preview returns versions and the upstream diff", async () => {
  const result = await authentikPreview(ctx(), fetchFn);
  expect(result).toMatchObject({ ok: true, from: "2026.8.4", to: "2026.10.2" });
  if (!result.ok) return;
  expect(result.diff).toContain("---");
  expect(result.diff).toContain("+++");
  expect(result.diff).toContain("-    restart: always");
  expect(result.diff).toContain("+    restart: unless-stopped");
  expect(requested).toEqual([upstreamComposeUrl("2026.8"), upstreamComposeUrl("2026.10")]);
});

test("preview refuses local modifications", async () => {
  await writeFile(join(dir, "compose.yml"), `${localCompose}    extra: line\r\n`);
  expect(await authentikPreview(ctx(), fetchFn)).toEqual({ ok: false, error: localError });
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.8.4\n");
});

test("preview reports a missing upstream file", async () => {
  statuses[upstreamComposeUrl("2026.10")] = 404;
  expect(await authentikPreview(ctx(), fetchFn)).toEqual({
    ok: false,
    error: "compose.yml amont introuvable pour 2026.10 (HTTP 404)",
  });
});

for (const withOverride of [false, true]) {
  test(`minor update replaces compose.yml (override present: ${withOverride})`, async () => {
    if (withOverride) await writeFile(join(dir, "compose.override.yml"), "services: {}\n");
    expect(await authentikMinorUpdate(ctx(), fetchFn)).toBe("success");
    expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(upstream10);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.10.2\n");
    expect(store.rollback("authentik")).toMatchObject({
      to: "2026.8.4",
      data: { kind: "recipe", file: ".env", variable: "AUTHENTIK_TAG", value: "2026.8.4", compose: localCompose },
    });
    expect(docker.composeCalls.map((c) => c.args)).toEqual([["pull"], ["up", "-d"]]);
    const exists = await access(join(dir, "compose.override.yml")).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(withOverride);
  });
}

test("minor update refuses local modifications and changes nothing", async () => {
  const modified = `${localCompose}    extra: line\r\n`;
  await writeFile(join(dir, "compose.yml"), modified);
  expect(await authentikMinorUpdate(ctx(), fetchFn)).toBe("failed");
  expect(logs).toContain(localError);
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(modified);
  expect(store.rollback("authentik")).toBeNull();
  expect(docker.composeCalls).toEqual([]);
});

test("upstream 404 fails without changing anything", async () => {
  statuses[upstreamComposeUrl("2026.10")] = 404;
  expect(await authentikMinorUpdate(ctx(), fetchFn)).toBe("failed");
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(localCompose);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.8.4\n");
  expect(store.rollback("authentik")).toBeNull();
});

test("before command failure stops before any change", async () => {
  docker.shellExit = () => 2;
  expect(await authentikMinorUpdate(ctx({ before: ["backup"] }), fetchFn)).toBe("failed");
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(localCompose);
  expect(docker.composeCalls).toEqual([]);
});

test("a stopped stack gets the new compose.yml and version, is pulled and stays stopped", async () => {
  docker.containersByProject.set("authentik", []);
  expect(await authentikMinorUpdate(ctx(), fetchFn)).toBe("success");
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(upstream10);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.10.2\n");
  expect(docker.composeCalls.map((c) => c.args)).toEqual([["pull"]]);
  expect(logs).toContain("pile arrêtée : images téléchargées, pile laissée arrêtée");
});

test("a target that is not newer than the .env value is refused before anything is fetched or changed", async () => {
  await writeFile(join(dir, ".env"), "AUTHENTIK_TAG=2026.10.3\n");
  const message = "la version 2026.10.2 n'est pas plus récente que 2026.10.3 déjà dans .env : mise à jour annulée";
  expect(await authentikPreview(ctx(), fetchFn)).toEqual({ ok: false, error: message });
  expect(await authentikMinorUpdate(ctx(), fetchFn)).toBe("failed");
  expect(logs).toContain(message);
  expect(requested).toEqual([]);
  expect(await readFile(join(dir, "compose.yml"), "utf8")).toBe(localCompose);
  expect(await readFile(join(dir, ".env"), "utf8")).toBe("AUTHENTIK_TAG=2026.10.3\n");
  expect(store.rollback("authentik")).toBeNull();
  expect(docker.composeCalls).toEqual([]);
});
