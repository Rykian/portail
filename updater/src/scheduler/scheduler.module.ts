import { Module } from "@nestjs/common";
import { DetectionModule } from "../detection/detection.module";
import { JobsModule } from "../jobs/jobs.module";
import { SchedulerService } from "./scheduler.service";

/** Runs the 6-hourly check and the daily purge of old job logs. */
@Module({
  imports: [DetectionModule, JobsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
