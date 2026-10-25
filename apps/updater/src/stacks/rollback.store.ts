import type { Database } from "bun:sqlite";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { DATABASE } from "../database/database";

export type RollbackState = {
  stack: string;
  to: string;
  /** The update was a major bump: the rollback confirmation warns about migrations. */
  major: boolean;
  /** The stack was running before the update: a rollback leaves a stopped stack stopped. */
  running: boolean;
  data:
    | { kind: "version"; file: string; variable: string; value: string }
    | { kind: "recipe"; file: string; variable: string; value: string; compose: string };
};

export type RollbackData = RollbackState["data"];
export type RollbackKind = RollbackData["kind"];

/** Stack-level pull rollback stored before per-service points; only `migrateLegacy` reads it. */
type LegacyPullData = { kind: "pull"; services: { service: string; image: string }[] };

/** Rollback point of one pull-style service: replaced by the next update of that service only. */
export type PullPoint = {
  stack: string;
  service: string;
  image: string;
  to: string;
  /** Same meaning as in `RollbackState`, from the update that created this point. */
  major: boolean;
  running: boolean;
};

@Injectable()
export class RollbackStore implements OnModuleInit {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  onModuleInit(): void {
    const migrated = this.migrateLegacy();
    if (migrated > 0) console.warn(`${migrated} retour(s) arrière migré(s) par service`);
  }

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

  points(stack: string): PullPoint[] {
    const rows = this.db.query("SELECT json FROM rollback_points WHERE stack = ? ORDER BY service").all(stack) as {
      json: string;
    }[];
    return rows.map((row) => JSON.parse(row.json) as PullPoint);
  }

  savePoint(point: PullPoint): void {
    this.db
      .query(
        "INSERT INTO rollback_points (stack, service, json) VALUES (?, ?, ?) ON CONFLICT(stack, service) DO UPDATE SET json = excluded.json",
      )
      .run(point.stack, point.service, JSON.stringify(point));
  }

  deletePoint(stack: string, service: string): void {
    this.db.query("DELETE FROM rollback_points WHERE stack = ? AND service = ?").run(stack, service);
  }

  /** Splits the stack-level `pull` rows written before per-service points into one point per service. */
  migrateLegacy(): number {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT json FROM rollbacks").all() as { json: string }[];
      let migrated = 0;
      for (const row of rows) {
        const { stack, to, major, running, data } = JSON.parse(row.json) as Omit<RollbackState, "data"> & {
          data: RollbackData | LegacyPullData;
        };
        if (data.kind !== "pull") continue;
        for (const { service, image } of data.services) this.savePoint({ stack, service, image, to, major, running });
        this.delete(stack);
        migrated++;
      }
      return migrated;
    })();
  }
}
