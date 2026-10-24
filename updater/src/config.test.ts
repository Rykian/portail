import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createConfigLoader, parseConfig, stackConfig } from "./config";
import { tempDir } from "./test/fakes";

const example = `
exclude: [authelia, updater, wud, "*.back", "*.bak-*"]

stacks:
  mealie:
    version: { file: .env, variable: VERSION }
  authentik:
    recipe: authentik
    version: { file: .env, variable: AUTHENTIK_TAG }
  sure:
    confirm: true
    before:
      - docker compose exec -T db pg_dump -U sure sure > backups/sure-$(date +%F).sql
  downloads:
    before:
      - tar czf backups/seer-$(date +%F).tgz seer
    beforeOnlyOnMajor: true
  frigate: { confirm: true }
  traefik: { last: true }
  cloudflared: { last: true }
  portal: { last: true }
`;

test("parses the example config", () => {
  const config = parseConfig(example);
  expect(config.stacks.mealie.version).toEqual({ file: ".env", variable: "VERSION" });
  expect(config.stacks.frigate.confirm).toBe(true);
  expect(config.stacks.traefik.last).toBe(true);
  expect(config.stacks.downloads.beforeOnlyOnMajor).toBe(true);
  expect(config.exclude).toHaveLength(5);
});

test("empty text and {} give the empty config", () => {
  expect(parseConfig("")).toEqual({ exclude: [], stacks: {} });
  expect(parseConfig("{}")).toEqual({ exclude: [], stacks: {} });
});

test("rejects invalid configs", () => {
  expect(() => parseConfig("stacks: { x: { confrm: true } }")).toThrow();
  expect(() => parseConfig("stacks: { x: { recipe: authentik } }")).toThrow();
  expect(() => parseConfig('stacks: { x: { version: { file: .env, variable: "1BAD" } } }')).toThrow();
});

test("stackConfig returns defaults for an unknown stack", () => {
  expect(stackConfig(parseConfig(example), "unknown")).toEqual({
    confirm: false,
    last: false,
    before: [],
    beforeOnlyOnMajor: false,
  });
});

test("loader handles missing, invalid and recovered files", async () => {
  const dir = await tempDir();
  const path = join(dir, "sub", "config.yml");
  const load = createConfigLoader(path);
  expect(await load()).toEqual({ config: { exclude: [], stacks: {} }, error: null });

  await mkdir(join(dir, "sub"));
  await writeFile(path, "stacks: { a: { last: true } }");
  const good = await load();
  expect(good.error).toBeNull();
  expect(good.config.stacks.a.last).toBe(true);

  await writeFile(path, "stacks: { a: { lst: true } }");
  const bad = await load();
  expect(bad.config).toEqual(good.config);
  expect(bad.error).toContain("Unrecognized key");

  await writeFile(path, "stacks: { b: {} }");
  const again = await load();
  expect(again.error).toBeNull();
  expect(Object.keys(again.config.stacks)).toEqual(["b"]);
  await rm(dir, { recursive: true });
});
