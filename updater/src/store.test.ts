import { Database } from "bun:sqlite";
import { expect, test } from "vitest";
import type { StackStatus } from "@shared/updater-api";
import { Store, type RollbackState } from "./store";

function setup() {
  return new Store(new Database(":memory:"));
}

const input = (startedAt: string) => ({ kind: "update" as const, user: "me", steps: [], startedAt });

test("create, append logs in order, finish", () => {
  const store = setup();
  const job = store.createJob(input("2026-01-01T00:00:00.000Z"));
  expect(job.status).toBe("running");
  expect(job.endedAt).toBeNull();
  store.appendLog(job.id, "a");
  store.appendLog(job.id, "b");
  store.appendLog(job.id, "c");
  expect(store.jobLog(job.id)).toEqual(["a", "b", "c"]);
  store.finishJob(job.id, "success", "2026-01-01T00:01:00.000Z");
  expect(store.job(job.id)).toMatchObject({ status: "success", endedAt: "2026-01-01T00:01:00.000Z" });
  expect(store.job(999)).toBeNull();
});

test("history paginates newest first", () => {
  const store = setup();
  const ids = [1, 2, 3].map((n) => store.createJob(input(`2026-01-0${n}T00:00:00.000Z`)).id);
  const first = store.history(null, 2);
  expect(first.jobs.map((j) => j.id)).toEqual([ids[2], ids[1]]);
  expect(first.nextCursor).toBe(ids[1]);
  const second = store.history(first.nextCursor, 2);
  expect(second.jobs.map((j) => j.id)).toEqual([ids[0]]);
  expect(second.nextCursor).toBeNull();
});

test("history leaves out check jobs, which stay reachable by id", () => {
  const store = setup();
  const update = store.createJob(input("2026-01-01T00:00:00.000Z"));
  const check = store.createJob({ ...input("2026-01-02T00:00:00.000Z"), kind: "check", user: null });
  const rollback = store.createJob({ ...input("2026-01-03T00:00:00.000Z"), kind: "rollback" });
  expect(store.history(null).jobs.map((j) => j.id)).toEqual([rollback.id, update.id]);
  expect(store.history(rollback.id, 1)).toMatchObject({ jobs: [{ id: update.id }], nextCursor: null });
  expect(store.job(check.id)).toMatchObject({ kind: "check" });
});

test("markInterrupted only touches running jobs", () => {
  const store = setup();
  const a = store.createJob(input("2026-01-01T00:00:00.000Z"));
  const b = store.createJob(input("2026-01-02T00:00:00.000Z"));
  store.finishJob(b.id, "success", "2026-01-02T00:01:00.000Z");
  expect(store.markInterrupted("2026-01-03T00:00:00.000Z")).toBe(1);
  expect(store.job(a.id)).toMatchObject({ status: "interrupted", endedAt: "2026-01-03T00:00:00.000Z" });
  expect(store.job(b.id)?.status).toBe("success");
});

test("purgeLogs removes only old finished logs, keeps rows", () => {
  const store = setup();
  const old = store.createJob(input("2026-01-01T00:00:00.000Z"));
  const recent = store.createJob(input("2026-02-01T00:00:00.000Z"));
  const running = store.createJob(input("2026-01-01T00:00:00.000Z"));
  for (const j of [old, recent, running]) store.appendLog(j.id, "x");
  store.finishJob(old.id, "success", "2026-01-01T00:01:00.000Z");
  store.finishJob(recent.id, "success", "2026-02-01T00:01:00.000Z");
  expect(store.purgeLogs("2026-01-15T00:00:00.000Z")).toBe(1);
  expect(store.jobLog(old.id)).toEqual([]);
  expect(store.jobLog(recent.id)).toEqual(["x"]);
  expect(store.jobLog(running.id)).toEqual(["x"]);
  expect(store.job(old.id)).not.toBeNull();
});

test("rollback round-trip", () => {
  const store = setup();
  const state: RollbackState = {
    stack: "web",
    to: "1.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "V", value: "1.0" },
  };
  expect(store.rollback("web")).toBeNull();
  store.saveRollback(state);
  expect(store.rollback("web")).toEqual(state);
  store.deleteRollback("web");
  expect(store.rollback("web")).toBeNull();
});

test("saveStackStatuses replaces all; meta; setSteps", () => {
  const store = setup();
  const s = (name: string) => ({ name }) as unknown as StackStatus;
  store.saveStackStatuses([s("a"), s("b")]);
  store.saveStackStatuses([s("c")]);
  expect(store.stackStatuses()).toEqual([s("c")]);
  store.saveStackStatus(s("d"));
  expect(store.stackStatuses()).toHaveLength(2);
  expect(store.getMeta("k")).toBeNull();
  store.setMeta("k", "v");
  expect(store.getMeta("k")).toBe("v");
  store.setMeta("k", null);
  expect(store.getMeta("k")).toBeNull();
  const job = store.createJob(input("2026-01-01T00:00:00.000Z"));
  store.setSteps(job.id, [{ name: "x", status: "running" } as never]);
  expect(store.job(job.id)?.steps).toHaveLength(1);
});
