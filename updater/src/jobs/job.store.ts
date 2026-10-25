import type { Database } from "bun:sqlite";
import { Inject, Injectable } from "@nestjs/common";
import type { HistoryPage, Job, JobKind, JobStatus, JobStep } from "@shared/updater-api";
import { DATABASE } from "../database/database";

type JobRow = {
  id: number;
  kind: JobKind;
  user: string | null;
  started_at: string;
  ended_at: string | null;
  status: JobStatus;
  steps_json: string;
};

const toJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  user: row.user,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  status: row.status,
  steps: JSON.parse(row.steps_json) as JobStep[],
});

@Injectable()
export class JobStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  createJob(input: { kind: JobKind; user: string | null; steps: JobStep[]; startedAt: string }): Job {
    const result = this.db
      .query(
        "INSERT INTO jobs (kind, user, started_at, ended_at, status, steps_json) VALUES (?, ?, ?, NULL, 'running', ?)",
      )
      .run(input.kind, input.user, input.startedAt, JSON.stringify(input.steps));
    return {
      id: Number(result.lastInsertRowid),
      kind: input.kind,
      user: input.user,
      startedAt: input.startedAt,
      endedAt: null,
      status: "running",
      steps: input.steps,
    };
  }

  appendLog(id: number, line: string): void {
    this.db
      .query(
        "INSERT INTO job_logs (job_id, seq, line) SELECT ?1, coalesce(max(seq), 0) + 1, ?2 FROM job_logs WHERE job_id = ?1",
      )
      .run(id, line);
  }

  setSteps(id: number, steps: JobStep[]): void {
    this.db.query("UPDATE jobs SET steps_json = ? WHERE id = ?").run(JSON.stringify(steps), id);
  }

  finishJob(id: number, status: JobStatus, endedAt: string): void {
    this.db.query("UPDATE jobs SET status = ?, ended_at = ? WHERE id = ?").run(status, endedAt, id);
  }

  job(id: number): Job | null {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    return row ? toJob(row) : null;
  }

  jobLog(id: number): string[] {
    const rows = this.db.query("SELECT line FROM job_logs WHERE job_id = ? ORDER BY seq").all(id) as { line: string }[];
    return rows.map((r) => r.line);
  }

  history(cursor: number | null, limit = 20): HistoryPage {
    const rows = this.db
      .query("SELECT * FROM jobs WHERE kind != 'check' AND (?1 IS NULL OR id < ?1) ORDER BY id DESC LIMIT ?2")
      .all(cursor, limit + 1) as JobRow[];
    const page = rows.slice(0, limit).map(toJob);
    const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
    return { jobs: page, nextCursor };
  }

  markInterrupted(endedAt: string): number {
    const result = this.db
      .query("UPDATE jobs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(endedAt);
    return result.changes;
  }

  purgeLogs(endedBefore: string): number {
    const result = this.db
      .query("DELETE FROM job_logs WHERE job_id IN (SELECT id FROM jobs WHERE ended_at IS NOT NULL AND ended_at < ?)")
      .run(endedBefore);
    return result.changes;
  }
}
