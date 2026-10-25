import type { Database } from "bun:sqlite";
import { Inject, Injectable } from "@nestjs/common";
import { DATABASE } from "../database/database";

export type RollbackState = {
  stack: string;
  to: string;
  /** The update was a major bump: the rollback confirmation warns about migrations. */
  major: boolean;
  /** The stack was running before the update: a rollback leaves a stopped stack stopped. */
  running: boolean;
  data:
    | { kind: "pull"; services: { service: string; image: string }[] }
    | { kind: "version"; file: string; variable: string; value: string }
    | { kind: "recipe"; file: string; variable: string; value: string; compose: string };
};

export type RollbackData = RollbackState["data"];
export type RollbackKind = RollbackData["kind"];

@Injectable()
export class RollbackStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  save(state: RollbackState): void {
    this.db
      .query("INSERT INTO rollbacks (stack, json) VALUES (?, ?) ON CONFLICT(stack) DO UPDATE SET json = excluded.json")
      .run(state.stack, JSON.stringify(state));
  }

  get(stack: string): RollbackState | null {
    const row = this.db.query("SELECT json FROM rollbacks WHERE stack = ?").get(stack) as { json: string } | null;
    return row ? (JSON.parse(row.json) as RollbackState) : null;
  }

  delete(stack: string): void {
    this.db.query("DELETE FROM rollbacks WHERE stack = ?").run(stack);
  }
}
