import { expect, test, vi } from "vitest";
import { openDatabase } from "../database/database";
import { type PullPoint, RollbackStore, type RollbackState } from "./rollback.store";

test("rollback round-trip", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  const state: RollbackState = {
    stack: "web",
    to: "1.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "V", value: "1.0" },
  };
  expect(store.get("web")).toBeNull();
  store.save(state);
  expect(store.get("web")).toEqual(state);
  store.delete("web");
  expect(store.get("web")).toBeNull();
});

const point = (service: string, to: string): PullPoint => ({
  stack: "immich",
  service,
  image: `ghcr.io/immich-app/immich-${service}:release`,
  to,
  major: false,
  running: true,
});

test("a point per service, replaced by the next update of that service", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  store.savePoint(point("server", "v1.139"));
  store.savePoint(point("machine-learning", "v1.139"));
  store.savePoint({ ...point("server", "v1.140"), major: true, running: false });
  expect(store.points("immich")).toEqual([
    point("machine-learning", "v1.139"),
    { ...point("server", "v1.140"), major: true, running: false },
  ]);
});

test("points of other services are left alone", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  store.savePoint(point("server", "v1.140"));
  store.savePoint(point("machine-learning", "v1.140"));
  store.savePoint({ ...point("server", "v1.140"), stack: "other" });
  store.deletePoint("immich", "server");
  expect(store.points("immich")).toEqual([point("machine-learning", "v1.140")]);
  expect(store.points("other")).toEqual([{ ...point("server", "v1.140"), stack: "other" }]);
  expect(store.points("unknown")).toEqual([]);
});

test("migrates a legacy pull row into per-service points", () => {
  const db = openDatabase(":memory:");
  db.query("INSERT INTO rollbacks (stack, json) VALUES (?, ?)").run(
    "immich",
    '{"stack":"immich","to":"v1.140","major":true,"running":true,"data":{"kind":"pull","services":[{"service":"server","image":"ghcr.io/immich-app/immich-server:release"},{"service":"machine-learning","image":"ghcr.io/immich-app/immich-machine-learning:release"}]}}',
  );
  const store = new RollbackStore(db);
  expect(store.migrateLegacy()).toBe(1);
  expect(store.get("immich")).toBeNull();
  const migrated = { to: "v1.140", major: true, running: true };
  expect(store.points("immich")).toEqual([
    { ...point("machine-learning", "v1.140"), ...migrated },
    { ...point("server", "v1.140"), ...migrated },
  ]);
  expect(store.migrateLegacy()).toBe(0);
  expect(store.points("immich")).toHaveLength(2);
});

test("version and recipe rows are not migrated", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  const version: RollbackState = {
    stack: "web",
    to: "1.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "V", value: "0.9" },
  };
  const recipe: RollbackState = {
    stack: "auth",
    to: "2026.2",
    major: true,
    running: false,
    data: { kind: "recipe", file: ".env", variable: "V", value: "2026.1", compose: "services: {}\n" },
  };
  store.save(version);
  store.save(recipe);
  expect(store.migrateLegacy()).toBe(0);
  expect(store.get("web")).toEqual(version);
  expect(store.get("auth")).toEqual(recipe);
  expect(store.points("web")).toEqual([]);
  expect(store.points("auth")).toEqual([]);
});

test("start-up migrates legacy rows and says how many", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  store.save({ stack: "immich", to: "v1.140", major: false, running: true, data: { kind: "pull", services: [] } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  store.onModuleInit();
  expect(warn).toHaveBeenCalledWith("1 retour(s) arrière migré(s) par service");
  warn.mockClear();
  store.onModuleInit();
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
