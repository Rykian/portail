import { expect, test } from "vitest";
import { readEnv } from "./runtime";

test("readEnv gives the defaults for everything but the token", () => {
  expect(readEnv({ UPDATER_TOKEN: "t" })).toEqual({
    token: "t",
    port: 8080,
    root: "/root",
    configPath: "/root/updater/config.yml",
    dataDir: "/data",
  });
});

test("readEnv reads every variable", () => {
  const vars = { UPDATER_TOKEN: "t", PORT: "18089", UPDATER_ROOT: "/r", UPDATER_CONFIG: "/c.yml", UPDATER_DATA: "/d" };
  expect(readEnv(vars)).toEqual({ token: "t", port: 18089, root: "/r", configPath: "/c.yml", dataDir: "/d" });
});

test("readEnv is null when the token is missing or empty", () => {
  expect(readEnv({})).toBeNull();
  expect(readEnv({ UPDATER_TOKEN: "" })).toBeNull();
});
