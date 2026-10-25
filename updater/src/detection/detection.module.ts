import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { DockerModule } from "../docker/docker.module";
import { JobsModule } from "../jobs/jobs.module";
import { StacksModule } from "../stacks/stacks.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { DetectionController } from "./detection.controller";
import { DetectionService } from "./detection.service";

/** Looking for updates: the check job, the per-service checks, and the list of stacks with their status. */
@Module({
  imports: [ConfigModule, DockerModule, StacksModule, StrategiesModule, JobsModule],
  controllers: [DetectionController],
  providers: [DetectionService],
  exports: [DetectionService],
})
export class DetectionModule {}
