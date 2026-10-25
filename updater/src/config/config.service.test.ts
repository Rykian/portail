import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../test/fakes";
import { testEnv } from "../test/module";
import { ConfigService } from "./config.service";

test("loader handles missing, invalid and recovered files", async () => {
  const dir = await tempDir();
  const path = join(dir, "sub", "config.yml");
  const config = new ConfigService(testEnv({ configPath: path }));
  expect(await config.load()).toEqual({ config: { exclude: [], stacks: {} }, error: null });

  await mkdir(join(dir, "sub"));
  await writeFile(path, "stacks: { a: { last: true } }");
  const good = await config.load();
  expect(good.error).toBeNull();
  expect(good.config.stacks.a.last).toBe(true);

  await writeFile(path, "stacks: { a: { lst: true } }");
  const bad = await config.load();
  expect(bad.config).toEqual(good.config);
  expect(bad.error).toContain("Unrecognized key");

  await writeFile(path, "stacks: { b: {} }");
  const again = await config.load();
  expect(again.error).toBeNull();
  expect(Object.keys(again.config.stacks)).toEqual(["b"]);
  await rm(dir, { recursive: true });
});
