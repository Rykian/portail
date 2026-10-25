import "reflect-metadata";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { openDatabase } from "./database/database";
import { JobRunner } from "./jobs/job-runner";
import { JobStore } from "./jobs/job.store";
import { SchedulerService } from "./scheduler/scheduler.service";
import { tempDir } from "./test/fakes";
import { testModule } from "./test/module";

const NOW = new Date("2026-10-24T10:00:00.000Z");

test("start-up marks interrupted jobs before the scheduler's first check; close stops the scheduler", async () => {
  const database = openDatabase(":memory:");
  const old = new JobStore(database).createJob({
    kind: "update",
    user: null,
    steps: [],
    startedAt: "2026-10-24T09:00:00.000Z",
  });
  const root = await tempDir();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const moduleRef = await testModule({ database, now: () => NOW, env: { root, configPath: join(root, "config.yml") } });
  const app = moduleRef.createNestApplication({ logger: false });

  await app.init();
  const jobs = moduleRef.get(JobStore);
  expect(jobs.job(old.id)).toMatchObject({ status: "interrupted", endedAt: NOW.toISOString() });
  expect(warn).toHaveBeenCalledWith("1 tâche(s) marquée(s) interrompue(s)");
  await moduleRef.get(JobRunner).idle();
  expect(jobs.job(old.id + 1)).toMatchObject({ kind: "check", status: "success" });

  const stop = vi.spyOn(moduleRef.get(SchedulerService), "stop");
  await app.close();
  expect(stop).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
