import { Database } from "bun:sqlite";

/** Injection token for the single SQLite connection shared by the stores. */
export const DATABASE = Symbol("DATABASE");

/** Opens (and creates when missing) the updater database. */
export function openDatabase(file: string): Database {
  const db = new Database(file);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS stacks (name TEXT PRIMARY KEY, json TEXT NOT NULL)");
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      user TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      steps_json TEXT NOT NULL
    )`);
  db.run(`CREATE TABLE IF NOT EXISTS job_logs (
      job_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      line TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    )`);
  db.run("CREATE TABLE IF NOT EXISTS rollbacks (stack TEXT PRIMARY KEY, json TEXT NOT NULL)");
  return db;
}
