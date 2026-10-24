import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { JobRunner } from "./jobs";
import { startScheduler } from "./scheduler";
import type { UpdaterService } from "./service";
import { Store } from "./store";

const HOUR = 3_600_000;
const START = new Date("2026-10-24T10:00:00.000Z").getTime();

let store: Store;
let jobs: JobRunner;
let check: ReturnType<typeof vi.fn>;
let service: UpdaterService;
const now = () => new Date(Date.now());

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  store = new Store(new Database(":memory:"));
  jobs = new JobRunner(store, now);
  check = vi.fn();
  service = { check } as unknown as UpdaterService;
});

afterEach(() => {
  vi.useRealTimers();
});

test("checks at start when never checked, then every 6 h", () => {
  const stop = startScheduler(service, jobs, store, now);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(null);
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
  stop();
  vi.advanceTimersByTime(12 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
});

test("skips the start-up check when the last one is recent", () => {
  store.setMeta("lastCheck", new Date(START - 5 * HOUR).toISOString());
  const stop = startScheduler(service, jobs, store, now);
  expect(check).not.toHaveBeenCalled();
  stop();

  store.setMeta("lastCheck", new Date(START - 7 * HOUR).toISOString());
  startScheduler(service, jobs, store, now)();
  expect(check).toHaveBeenCalledTimes(1);
});

test("skips a scheduled check while a job runs", () => {
  store.setMeta("lastCheck", new Date(START).toISOString());
  const stop = startScheduler(service, jobs, store, now);
  jobs.start({ kind: "update", user: null, steps: [] }, () => new Promise(() => {}));
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).not.toHaveBeenCalled();
  stop();
});

test("purges logs older than 90 days once a day", () => {
  store.setMeta("lastCheck", new Date(START).toISOString());
  const purge = vi.spyOn(store, "purgeLogs");
  const stop = startScheduler(service, jobs, store, now);
  expect(purge).toHaveBeenCalledWith(new Date(START - 90 * 24 * HOUR).toISOString());
  vi.advanceTimersByTime(24 * HOUR);
  expect(purge).toHaveBeenCalledTimes(2);
  expect(purge).toHaveBeenLastCalledWith(new Date(START - 89 * 24 * HOUR).toISOString());
  stop();
});
