import { Module } from "@nestjs/common";
import { DOCKER } from "./docker";
import { createDockerCli, pullImage } from "./docker-cli";
import { createEnginePuller, IMAGE_PULLER } from "./engine";
import { createHttpRegistry, REGISTRY } from "./registry";

/** The outside tools the updater drives: the Docker CLI and Engine API, and the image registries. */
@Module({
  providers: [
    { provide: DOCKER, useFactory: createDockerCli },
    { provide: REGISTRY, useFactory: () => createHttpRegistry() },
    {
      provide: IMAGE_PULLER,
      useFactory: () =>
        createEnginePuller({
          socket: "/var/run/docker.sock",
          dockerConfigPath: `${process.env.HOME ?? "/root"}/.docker/config.json`,
          cliPull: pullImage,
        }),
    },
  ],
  exports: [DOCKER, REGISTRY, IMAGE_PULLER],
})
export class DockerModule {}
