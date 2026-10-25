import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverStacks } from "./discovery";
import { tempDir } from "../test/fakes";

async function makeRoot(layout: Record<string, string[]>): Promise<string> {
  const root = await tempDir();
  for (const [dir, files] of Object.entries(layout)) {
    await mkdir(join(root, dir));
    for (const file of files) await writeFile(join(root, dir, file), "services: {}\n");
  }
  return root;
}

test("lists stacks with a compose file, skipping excluded and updater", async () => {
  const root = await makeRoot({
    a: ["compose.yml"],
    b: ["docker-compose.yaml"],
    c: [],
    "x.back": ["compose.yml"],
    "y.bak-2026": ["compose.yml"],
    updater: ["compose.yml"],
  });
  await writeFile(join(root, "notes.txt"), "hi");
  const stacks = await discoverStacks(root, ["*.back", "*.bak-*"]);
  expect(stacks).toEqual([
    { name: "a", dir: join(root, "a"), composeFile: "compose.yml" },
    { name: "b", dir: join(root, "b"), composeFile: "docker-compose.yaml" },
  ]);
});

test("prefers compose.yml over docker-compose.yml", async () => {
  const root = await makeRoot({ a: ["docker-compose.yml", "compose.yml"] });
  expect((await discoverStacks(root, []))[0].composeFile).toBe("compose.yml");
});

test("exclude removes a stack by name", async () => {
  const root = await makeRoot({ a: ["compose.yml"], b: ["compose.yml"] });
  expect((await discoverStacks(root, ["a"])).map((s) => s.name)).toEqual(["b"]);
});
