import type { Database } from "bun:sqlite";
import { Inject, Injectable } from "@nestjs/common";
import type { StackStatus } from "@portail/shared/updater-api";
import { DATABASE } from "../database/database";

@Injectable()
export class StackStatusStore {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string | null } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  stackStatuses(): StackStatus[] {
    const rows = this.db.query("SELECT json FROM stacks ORDER BY name").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as StackStatus);
  }

  saveStackStatuses(list: StackStatus[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM stacks").run();
      for (const status of list) this.saveStackStatus(status);
    })();
  }

  saveStackStatus(status: StackStatus): void {
    this.db
      .query("INSERT INTO stacks (name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json")
      .run(status.name, JSON.stringify(status));
  }
}
