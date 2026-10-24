import { Module, type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import type { UpdaterService } from "../service";
import { AuthGuard } from "./auth.guard";
import { ErrorFilter, UpdaterController } from "./controllers";
import { UPDATER_SERVICE, UPDATER_TOKEN } from "./tokens";

@Module({ controllers: [UpdaterController] })
class AppModule {}

export async function createApp(service: UpdaterService, token: string): Promise<INestApplication> {
  return NestFactory.create(
    {
      module: AppModule,
      providers: [
        { provide: UPDATER_SERVICE, useValue: service },
        { provide: UPDATER_TOKEN, useValue: token },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    },
    { logger: ["error", "warn"] },
  );
}
