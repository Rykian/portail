import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "./database/database";
import { JobRunner } from "./jobs";
import { JobStore } from "./jobs/job.store";
import { startScheduler } from "./scheduler";
import type { UpdaterService } from "./service";
import { StackStatusStore } from "./stacks/stack-status.store";

const HOUR = 3_600_000;
const START = new Date("2026-10-24T10:00:00.000Z").getTime();

let statuses: StackStatusStore;
let jobStore: JobStore;
let jobs: JobRunner;
let check: ReturnType<typeof vi.fn>;
let service: UpdaterService;
const now = () => new Date(Date.now());

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  const db = openDatabase(":memory:");
  statuses = new StackStatusStore(db);
  jobStore = new JobStore(db);
  jobs = new JobRunner(jobStore, now);
  check = vi.fn();
  service = { check } as unknown as UpdaterService;
});

afterEach(() => {
  vi.useRealTimers();
});

test("checks at start when never checked, then every 6 h", () => {
  const stop = startScheduler(service, jobs, statuses, jobStore, now);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(null);
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
  stop();
  vi.advanceTimersByTime(12 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
});

test("skips the start-up check when the last one is recent", () => {
  statuses.setMeta("lastCheck", new Date(START - 5 * HOUR).toISOString());
  const stop = startScheduler(service, jobs, statuses, jobStore, now);
  expect(check).not.toHaveBeenCalled();
  stop();

  statuses.setMeta("lastCheck", new Date(START - 7 * HOUR).toISOString());
  startScheduler(service, jobs, statuses, jobStore, now)();
  expect(check).toHaveBeenCalledTimes(1);
});

test("skips a scheduled check while a job runs", () => {
  statuses.setMeta("lastCheck", new Date(START).toISOString());
  const stop = startScheduler(service, jobs, statuses, jobStore, now);
  jobs.start({ kind: "update", user: null, steps: [] }, () => new Promise(() => {}));
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).not.toHaveBeenCalled();
  stop();
});

test("purges logs older than 90 days once a day", () => {
  statuses.setMeta("lastCheck", new Date(START).toISOString());
  const purge = vi.spyOn(jobStore, "purgeLogs");
  const stop = startScheduler(service, jobs, statuses, jobStore, now);
  expect(purge).toHaveBeenCalledWith(new Date(START - 90 * 24 * HOUR).toISOString());
  vi.advanceTimersByTime(24 * HOUR);
  expect(purge).toHaveBeenCalledTimes(2);
  expect(purge).toHaveBeenLastCalledWith(new Date(START - 89 * 24 * HOUR).toISOString());
  stop();
});
