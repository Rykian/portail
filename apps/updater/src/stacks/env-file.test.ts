import { chmod, lstat, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readVariable, readVariableFile, rewriteVariable, writeVariableFile } from "./env-file";
import { tempDir } from "../test/fakes";

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

test("hash and quotes inside values", () => {
  expect(readVariable('V="a#b"\n', "V")).toBe("a#b");
  expect(rewriteVariable('V="a#b" # c\n', "V", "2")).toBe('V="2" # c\n');
  expect(readVariable(`V='x"y'`, "V")).toBe('x"y');
  expect(rewriteVariable(`V='x"y'`, "V", "2")).toBe("V='2'");
  expect(readVariable("V=a#b", "V")).toBe("a#b");
  expect(readVariable("V=1 2", "V")).toBe("1 2");
  expect(rewriteVariable("V=1 2 # c", "V", "3")).toBe("V=3 # c");
});

test("empty values, comments and tabs", () => {
  expect(rewriteVariable("VERSION=\n", "VERSION", "2")).toBe("VERSION=2\n");
  expect(rewriteVariable('VERSION=""\n', "VERSION", "2")).toBe('VERSION="2"\n');
  expect(rewriteVariable("VERSION= # c", "VERSION", "2")).toBe("VERSION=2 # c");
  expect(rewriteVariable("VERSION=# c", "VERSION", "2")).toBe("VERSION=2 # c");
  expect(rewriteVariable("VERSION\t=\t1", "VERSION", "2")).toBe("VERSION\t=\t2");
  expect(rewriteVariable("A=1\r\nVERSION=1", "VERSION", "2")).toBe("A=1\r\nVERSION=2");
});

test("malformed last definition throws, never falls back", () => {
  const text = 'V=1\nV="abc\n';
  expect(() => readVariable(text, "V")).toThrow(/V/);
  expect(() => rewriteVariable(text, "V", "2")).toThrow(/V/);
});

test("rejects unsafe new values", () => {
  for (const bad of ["", "a b", "a\nb", 'a"b', "a#b"]) {
    expect(() => rewriteVariable("V=1", "V", bad)).toThrow(/V/);
  }
});

test("writeVariableFile leaves the file untouched on failure", async () => {
  const dir = await tempDir();
  const path = join(dir, ".env");
  await writeFile(path, "A=1\n");
  await expect(writeVariableFile(path, "V", "2")).rejects.toThrow(/V.*\.env/);
  await expect(writeVariableFile(path, "A", "a b")).rejects.toThrow(/A/);
  expect(await readFile(path, "utf8")).toBe("A=1\n");
  expect(await readdir(dir)).toEqual([".env"]);
});

test("writeVariableFile keeps mode and symlinks", async () => {
  const dir = await tempDir();
  const real = join(dir, "real.env");
  const link = join(dir, ".env");
  await writeFile(real, "V=1\n", { mode: 0o600 });
  await chmod(real, 0o600);
  await symlink("real.env", link);
  await writeVariableFile(link, "V", "2");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await readFile(real, "utf8")).toBe("V=2\n");
  expect((await stat(real)).mode & 0o777).toBe(0o600);
});

test("failed write leaves no temp file", async () => {
  const dir = await tempDir();
  const path = join(dir, ".env");
  await writeFile(path, "V=1\n");
  await chmod(dir, 0o500);
  try {
    await expect(writeVariableFile(path, "V", "2")).rejects.toThrow();
  } finally {
    await chmod(dir, 0o700);
  }
  expect(await readdir(dir)).toEqual([".env"]);
  expect(await readFile(path, "utf8")).toBe("V=1\n");
});
