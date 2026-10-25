import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { ENV, type Env } from "../common/runtime";
import { DATABASE, openDatabase } from "./database";

/** The updater's single SQLite connection, in the data directory, shared by every store. */
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (env: Env) => {
        mkdirSync(env.dataDir, { recursive: true });
        return openDatabase(join(env.dataDir, "updater.db"));
      },
      inject: [ENV],
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
