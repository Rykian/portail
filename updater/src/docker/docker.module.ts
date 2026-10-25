import { Module } from "@nestjs/common";
import { DOCKER } from "./docker";
import { createDockerCli } from "./docker-cli";
import { createHttpRegistry, REGISTRY } from "./registry";

/** The outside tools the updater drives: the Docker CLI and the image registries. */
@Module({
  providers: [
    { provide: DOCKER, useFactory: createDockerCli },
    { provide: REGISTRY, useFactory: () => createHttpRegistry() },
  ],
  exports: [DOCKER, REGISTRY],
})
export class DockerModule {}
