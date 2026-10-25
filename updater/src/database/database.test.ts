import { Database } from "bun:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JobStore } from "../jobs/job.store";
import { RollbackStore } from "../stacks/rollback.store";
import { tempDir } from "../test/fakes";
import { openDatabase } from "./database";

// Frozen copy of the statements the pre-refactor Store ran: the deployed updater.db was created with these.
const LEGACY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
  "CREATE TABLE IF NOT EXISTS stacks (name TEXT PRIMARY KEY, json TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      user TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS job_logs (
      job_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      line TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    )`,
  "CREATE TABLE IF NOT EXISTS rollbacks (stack TEXT PRIMARY KEY, json TEXT NOT NULL)",
];

const tables = (db: Database) =>
  db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();

test("openDatabase creates exactly the pre-refactor tables", () => {
  const legacy = new Database(":memory:");
  for (const statement of LEGACY_SCHEMA) legacy.run(statement);
  expect(tables(openDatabase(":memory:"))).toEqual(tables(legacy));
});

test("reopening an existing file keeps its rows", async () => {
  const file = join(await tempDir(), "updater.db");
  const first = openDatabase(file);
  const job = new JobStore(first).createJob({
    kind: "update",
    user: "a@b.c",
    steps: [],
    startedAt: "2026-10-24T10:00:00.000Z",
  });
  new RollbackStore(first).save({
    stack: "web",
    to: "1.0",
    major: false,
    running: true,
    data: { kind: "pull", services: [] },
  });
  first.close();
  const second = openDatabase(file);
  expect(new JobStore(second).job(job.id)).toMatchObject({ kind: "update", user: "a@b.c" });
  expect(new RollbackStore(second).get("web")).toMatchObject({ to: "1.0" });
});
