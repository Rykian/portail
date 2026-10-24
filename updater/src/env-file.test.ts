import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readVariable, readVariableFile, rewriteVariable, writeVariableFile } from "./env-file";
import { tempDir } from "./test/fakes";

const env = 'A=1\r\nexport VERSION="v3.4.0" # pinned\r\nB=2';

test("reads the value without quotes", () => {
  expect(readVariable(env, "VERSION")).toBe("v3.4.0");
  expect(readVariable("A=1", "VERSION")).toBeNull();
  expect(readVariable("V=1\nV=2\n", "V")).toBe("2");
});

test("rewrites only the value and keeps every other byte", () => {
  expect(rewriteVariable(env, "VERSION", "v3.5.0")).toBe('A=1\r\nexport VERSION="v3.5.0" # pinned\r\nB=2');
  expect(rewriteVariable("V='1'\n", "V", "2")).toBe("V='2'\n");
  expect(rewriteVariable("V=1 # c\n", "V", "2")).toBe("V=2 # c\n");
});

test("rewrites only the last definition", () => {
  expect(rewriteVariable("V=1\nV=2\n", "V", "3")).toBe("V=1\nV=3\n");
});

test("ignores look-alike lines", () => {
  expect(rewriteVariable("VERSIONX=1\n#VERSION=0\nVERSION = 1", "VERSION", "2")).toBe(
    "VERSIONX=1\n#VERSION=0\nVERSION = 2",
  );
});

test("throws when the variable is absent", () => {
  expect(() => rewriteVariable("A=1\n", "VERSION", "2")).toThrow(/VERSION/);
});

test("file helpers", async () => {
  const dir = await tempDir();
  const path = join(dir, ".env");
  expect(await readVariableFile(path, "VERSION")).toBeNull();
  await writeFile(path, env);
  expect(await readVariableFile(path, "VERSION")).toBe("v3.4.0");
  await writeVariableFile(path, "VERSION", "v3.5.0");
  expect(await readFile(path, "utf8")).toBe(rewriteVariable(env, "VERSION", "v3.5.0"));
  expect(await readdir(dir)).toEqual([".env"]);
  await expect(writeVariableFile(path, "NOPE", "1")).rejects.toThrow(/NOPE.*\.env/);
});
