import type { ServiceStatus, StackStatus } from "@portail/shared/updater-api";
import { expect, test } from "vitest";
import type { StackConfig } from "../config/config";
import { FakeDocker } from "../test/fakes";
import { AuthentikMinorStrategy } from "./authentik-minor.strategy";
import { PullStrategy } from "./pull.strategy";
import { selectableServices, selectionMajor, Strategies } from "./strategies";
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
  selectable: false,
  serviceRollbacks: [],
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

const service = (name: string, extra: Partial<ServiceStatus> = {}): ServiceStatus => ({
  name,
  image: `ghcr.io/immich-app/immich-${name}:release`,
  kind: "floating",
  current: null,
  available: null,
  newImageDate: null,
  update: true,
  error: null,
  ...extra,
});

const immichServices = [
  service("server"),
  service("machine-learning"),
  service("redis", { kind: "literal" }),
  service("postgres", { kind: "pinned" }),
  service("web", { update: false }),
  service("app", { kind: "variable" }),
];

test.each([
  ["pull stack", { mode: "pull" }, baseConfig, ["server", "machine-learning"]],
  ["version stack, sidecar only", { mode: "version", available: null }, versionCfg, ["server", "machine-learning"]],
  ["recipe stack, sidecar only", { mode: "recipe", available: null }, recipeCfg, ["server", "machine-learning"]],
  ["version stack with a target", { mode: "version", available: "v2.0.0" }, versionCfg, []],
  ["version config gone", { mode: "version", available: null }, baseConfig, []],
] as const)("selectableServices: %s", (_, status, config, expected) => {
  expect(selectableServices({ ...baseStatus, ...status, services: immichServices }, config)).toEqual(expected);
});

test("selectionMajor", () => {
  const status = {
    ...baseStatus,
    services: [
      service("server", { current: "v1.0.0", available: "v2.0.0" }),
      service("machine-learning", { current: "v1.1.0", available: "v1.2.0" }),
      service("redis", { current: null, available: "v9.0.0" }),
    ],
  };
  expect(selectionMajor(status, ["server"])).toBe(true);
  expect(selectionMajor(status, ["machine-learning", "server"])).toBe(true);
  expect(selectionMajor(status, ["machine-learning"])).toBe(false);
  expect(selectionMajor(status, ["redis"])).toBe(false);
  expect(selectionMajor(status, ["unknown"])).toBe(false);
  expect(selectionMajor(status, [])).toBe(false);
});
