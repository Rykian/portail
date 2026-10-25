import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AppController } from "./app.controller";
import { AuthGuard } from "./auth.guard";
import type { Env } from "./common/runtime";
import { RuntimeModule } from "./common/runtime.module";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { DetectionModule } from "./detection/detection.module";
import { DockerModule } from "./docker/docker.module";
import { ErrorFilter } from "./error.filter";
import { JobsModule } from "./jobs/jobs.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { StacksModule } from "./stacks/stacks.module";
import { StrategiesModule } from "./strategies/strategies.module";
import { UpdateModule } from "./update/update.module";

/** The updater: brings the domain modules together and adds `/health`, the token check and the JSON error format. */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    DockerModule,
    StacksModule,
    StrategiesModule,
    JobsModule,
    DetectionModule,
    UpdateModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule {
  /** Adds the environment, clock and fetch every module may inject. */
  static forRoot(env: Env): DynamicModule {
    return { module: AppModule, imports: [RuntimeModule.forRoot(env)] };
  }
}
