import type { StackStatus } from "@portail/shared/updater-api";
import { expect, test } from "vitest";
import type { StackConfig } from "../config/config";
import { FakeDocker } from "../test/fakes";
import { AuthentikMinorStrategy } from "./authentik-minor.strategy";
import { PullStrategy } from "./pull.strategy";
import { Strategies } from "./strategies";
import { VersionStrategy } from "./version.strategy";

const baseConfig: StackConfig = { confirm: false, last: false, before: [], beforeOnlyOnMajor: false };
const versionCfg = { ...baseConfig, version: { file: ".env", variable: "VERSION" } };
const recipeCfg = { ...baseConfig, recipe: "authentik" as const, version: { file: ".env", variable: "AUTHENTIK_TAG" } };

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

const docker = new FakeDocker();
const strategies = new Strategies(
  new PullStrategy(docker),
  new VersionStrategy(docker),
  new AuthentikMinorStrategy(fetch, docker),
);

test.each([
  ["pull stack", { mode: "pull" }, baseConfig, "pull"],
  ["version stack with a target", { mode: "version", available: "v2.0.0" }, versionCfg, "version"],
  ["version stack, sidecar only", { mode: "version", available: null }, versionCfg, "pull"],
  [
    "authentik patch",
    { mode: "recipe", needsConfirm: false, current: "2026.8.3", available: "2026.8.4" },
    recipeCfg,
    "version",
  ],
  [
    "authentik minor",
    { mode: "recipe", needsConfirm: true, current: "2026.8.4", available: "2026.10.2" },
    recipeCfg,
    "recipe",
  ],
  ["authentik, sidecar only", { mode: "recipe", available: null }, recipeCfg, "pull"],
  ["version config gone", { mode: "version", available: null }, baseConfig, "version"],
] as const)("forUpdate: %s", (_, status, config, kind) => {
  expect(strategies.forUpdate({ ...baseStatus, ...status }, config).kind).toBe(kind);
});

test("target", () => {
  const tags = ["2026.8.3", "2026.8.4", "2026.10.0", "2026.10.2"];
  expect(strategies.target(recipeCfg, "variable", "2026.8.4", tags)).toEqual({ to: "2026.10.2", needsConfirm: true });
  expect(strategies.target(recipeCfg, "variable", "2026.8.3", tags)).toEqual({ to: "2026.8.4", needsConfirm: false });
  expect(strategies.target(recipeCfg, "variable", "2026.12.1", tags)).toEqual({ to: null, needsConfirm: false });
  expect(strategies.target(recipeCfg, "literal", "1.0.0", ["1.0.0", "1.1.0"])).toEqual({
    to: "1.1.0",
    needsConfirm: false,
  });
  expect(strategies.target(versionCfg, "variable", "v1.0.0", ["v1.0.0", "v1.2.0"])).toEqual({
    to: "v1.2.0",
    needsConfirm: false,
  });
});
