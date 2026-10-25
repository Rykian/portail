import { Module } from "@nestjs/common";
import { DockerModule } from "../docker/docker.module";
import { AuthentikMinorStrategy } from "./authentik-minor.strategy";
import { PullStrategy } from "./pull.strategy";
import { Strategies } from "./strategies";
import { VersionStrategy } from "./version.strategy";

/** The three ways of updating a stack (pull, version variable, Authentik minor) and the choice between them. */
@Module({
  imports: [DockerModule],
  providers: [PullStrategy, VersionStrategy, AuthentikMinorStrategy, Strategies],
  exports: [Strategies],
})
export class StrategiesModule {}
