import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module";
import { DetectionModule } from "../detection/detection.module";
import { DockerModule } from "../docker/docker.module";
import { JobsModule } from "../jobs/jobs.module";
import { StacksModule } from "../stacks/stacks.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { WAIT_HEALTHY, waitHealthy } from "./health";
import { StackUpdater } from "./stack-updater";
import { UpdateController } from "./update.controller";
import { UpdateService } from "./update.service";

/** Applying updates: single updates, rollbacks and update-all, over the flow every update shares (StackUpdater). */
@Module({
  imports: [ConfigModule, DockerModule, StacksModule, StrategiesModule, DetectionModule, JobsModule],
  controllers: [UpdateController],
  providers: [UpdateService, StackUpdater, { provide: WAIT_HEALTHY, useValue: waitHealthy }],
})
export class UpdateModule {}
