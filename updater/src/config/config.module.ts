import { Module } from "@nestjs/common";
import { ConfigService } from "./config.service";

/** The updater's configuration: loads `config.yml` and keeps the last valid one. */
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
