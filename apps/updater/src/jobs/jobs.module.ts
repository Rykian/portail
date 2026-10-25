import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { JobRunner } from "./job-runner";
import { JobStore } from "./job.store";
import { JobsController } from "./jobs.controller";

/** Background jobs: the one-at-a-time runner, the stored jobs and their logs, and the routes that read them. */
@Module({
  imports: [DatabaseModule],
  controllers: [JobsController],
  providers: [JobStore, JobRunner],
  exports: [JobStore, JobRunner],
})
export class JobsModule {}
