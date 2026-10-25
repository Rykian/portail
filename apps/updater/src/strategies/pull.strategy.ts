import { Inject, Injectable } from "@nestjs/common";
import { uniqueBy } from "remeda";
import { DOCKER, isUp, type ContainerState, type Docker } from "../docker/docker";
import { runCompose } from "../stacks/compose";
import type { StackContext } from "../stacks/stack-context";
import type { Plan, RollbackOf, UpdateStrategy } from "./strategy";

export const rollbackTag = (project: string, service: string): string =>
  `updater-rollback/${project}-${service}:latest`;

/** Floating tags: keeps the running images under a rollback tag, then the shared flow pulls and recreates. */
@Injectable()
export class PullStrategy implements UpdateStrategy<"pull"> {
  readonly kind = "pull";

  constructor(@Inject(DOCKER) private readonly docker: Docker) {}

  async prepare({ stack, status }: StackContext, before: ContainerState[]): Promise<Plan<"pull">> {
    const services = await this.docker.composeServices(stack.dir);
    const candidates = uniqueBy(before.filter(isUp), (c) => c.service).flatMap((container) => {
      const service = services.find((s) => s.name === container.service);
      // Docker refuses to tag an image onto a digest reference: pinned services cannot be rolled back.
      return service && !service.image.includes("@sha256:") ? [{ container, service }] : [];
    });
    const saved: { service: string; image: string }[] = [];
    for (const { container, service } of candidates) {
      await this.docker.tag(container.imageId, rollbackTag(stack.name, service.name));
      saved.push({ service: service.name, image: service.image });
    }
    return {
      rollbackTo: (status.mode === "pull" ? status.current : null) ?? "l'image précédente",
      rollback: { kind: "pull", services: saved },
      // Nothing to write: the pull of the shared flow brings the new images.
      apply: async () => {},
    };
  }

  async restore(ctx: StackContext, data: RollbackOf<"pull">, start: boolean): Promise<void> {
    const { stack, log } = ctx;
    for (const saved of data.services) {
      log(`== retour à l'image de ${saved.service}`);
      await this.docker.tag(rollbackTag(stack.name, saved.service), saved.image);
    }
    if (start) await runCompose(this.docker, ctx, ["up", "-d"]);
  }
}
