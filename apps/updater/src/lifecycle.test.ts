import "reflect-metadata";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Test } from "@nestjs/testing";
import { expect, test, vi } from "vitest";
import { AppModule } from "./app.module";
import { DATABASE, openDatabase } from "./database/database";
import { JobRunner } from "./jobs/job-runner";
import { JobStore } from "./jobs/job.store";
import { SchedulerService } from "./scheduler/scheduler.service";
import { tempDir } from "./test/fakes";
import { testEnv, testModule } from "./test/module";

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
  // Only `old` is counted: had the scheduler's check started first, its running job would be marked too.
  expect(warn).toHaveBeenCalledWith("1 tâche(s) marquée(s) interrompue(s)");
  await moduleRef.get(JobRunner).idle();
  expect(jobs.job(old.id + 1)).toMatchObject({ kind: "check", status: "success" });

  const stop = vi.spyOn(moduleRef.get(SchedulerService), "stop");
  await app.close();
  expect(stop).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("the real module graph resolves, and the database factory creates the data directory", async () => {
  const dataDir = join(await tempDir(), "data");
  // No overrides and no init(): every real provider is built, but nothing runs against Docker or the network.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(testEnv({ dataDir }))] }).compile();
  const database = moduleRef.get<Database>(DATABASE);
  expect(existsSync(join(dataDir, "updater.db"))).toBe(true);
  database.close();
});
