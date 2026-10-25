import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../database/database";
import type { DetectionService } from "../detection/detection.service";
import { JobRunner } from "../jobs/job-runner";
import { JobStore } from "../jobs/job.store";
import { SchedulerService } from "./scheduler.service";

const HOUR = 3_600_000;
const START = new Date("2026-10-24T10:00:00.000Z").getTime();

let lastCheck: string | null;
let jobStore: JobStore;
let jobs: JobRunner;
let check: ReturnType<typeof vi.fn>;
let scheduler: SchedulerService;
const now = () => new Date(Date.now());

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  jobStore = new JobStore(openDatabase(":memory:"));
  jobs = new JobRunner(jobStore, now);
  check = vi.fn();
  lastCheck = null;
  const detection = { check, lastCheck: () => lastCheck } as unknown as DetectionService;
  scheduler = new SchedulerService(detection, jobs, jobStore, now);
});

afterEach(() => {
  vi.useRealTimers();
});

test("checks at start when never checked, then every 6 h", () => {
  scheduler.start();
  expect(check).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledWith(null);
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
  scheduler.stop();
  vi.advanceTimersByTime(12 * HOUR);
  expect(check).toHaveBeenCalledTimes(2);
});

test("skips the start-up check when the last one is recent", () => {
  lastCheck = new Date(START - 5 * HOUR).toISOString();
  scheduler.start();
  expect(check).not.toHaveBeenCalled();
  scheduler.stop();

  lastCheck = new Date(START - 7 * HOUR).toISOString();
  scheduler.start();
  scheduler.stop();
  expect(check).toHaveBeenCalledTimes(1);
});

test("skips a scheduled check while a job runs", () => {
  lastCheck = new Date(START).toISOString();
  scheduler.start();
  jobs.start({ kind: "update", user: null, steps: [] }, () => new Promise(() => {}));
  vi.advanceTimersByTime(6 * HOUR);
  expect(check).not.toHaveBeenCalled();
  scheduler.stop();
});

test("purges logs older than 90 days once a day", () => {
  lastCheck = new Date(START).toISOString();
  const purge = vi.spyOn(jobStore, "purgeLogs");
  scheduler.start();
  expect(purge).toHaveBeenCalledWith(new Date(START - 90 * 24 * HOUR).toISOString());
  vi.advanceTimersByTime(24 * HOUR);
  expect(purge).toHaveBeenCalledTimes(2);
  expect(purge).toHaveBeenLastCalledWith(new Date(START - 89 * 24 * HOUR).toISOString());
  scheduler.stop();
});
