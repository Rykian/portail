import { Inject, Injectable } from "@nestjs/common";
import { uniqueBy } from "remeda";
import { DOCKER, isUp, type ContainerState, type Docker } from "../docker/docker";
import { isMajorBump } from "../docker/versions";
import { runCompose } from "../stacks/compose";
import { fail } from "../stacks/fail";
import type { PullPoint } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import type { PullPlan, UpdateStrategy } from "./strategy";

/** Same format as the portal's image dates. */
const imageDate = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" });

export const rollbackTag = (project: string, service: string): string =>
  `updater-rollback/${project}-${service}:latest`;

/** Floating tags: keeps the running images of the targeted services under a rollback tag; the shared flow pulls and recreates them. */
@Injectable()
export class PullStrategy implements UpdateStrategy<"pull"> {
  readonly kind = "pull";

  constructor(@Inject(DOCKER) private readonly docker: Docker) {}

  async prepare(ctx: StackContext, before: ContainerState[]): Promise<PullPlan> {
    const { stack, status } = ctx;
    const services = await this.docker.composeServices(stack.dir);
    // StackUpdater has already turned a missing selection into every selectable service.
    const selection = ctx.selection ?? [];
    if (selection.length === 0) fail("aucun service à mettre à jour");
    for (const name of selection) {
      if (!services.some((s) => s.name === name)) fail(`${name} n'est plus dans la stack`);
    }
    const running = before.some(isUp);
    const candidates = uniqueBy(before.filter(isUp), (c) => c.service).flatMap((container) => {
      const service = services.find((s) => s.name === container.service);
      // Docker refuses to tag an image onto a digest reference: pinned services cannot be rolled back.
      return service && selection.includes(service.name) && !service.image.includes("@sha256:")
        ? [{ container, service }]
        : [];
    });
    const points: PullPoint[] = [];
    for (const { container, service } of candidates) {
      await this.docker.tag(container.imageId, rollbackTag(stack.name, service.name));
      const checked = status.services.find((s) => s.name === service.name);
      const current = checked?.current ?? null;
      const available = checked?.available ?? null;
      points.push({
        stack: stack.name,
        service: service.name,
        image: service.image,
        to: current ?? (await this.runningImageLabel(container.imageId)),
        major: current !== null && available !== null && isMajorBump(current, available),
        running,
      });
    }
    return {
      kind: "pull",
      services,
      selection,
      points,
      // Nothing to write: the pull of the shared flow brings the new images.
      apply: async () => {},
    };
  }

  /** What a rollback brings back when the service has no version: the running image, by its creation date if known. */
  private async runningImageLabel(imageId: string): Promise<string> {
    const created = (await this.docker.image(imageId))?.created;
    const date = created ? new Date(created) : null;
    return date && !Number.isNaN(date.getTime()) ? `l'image du ${imageDate.format(date)}` : "l'image précédente";
  }

  /**
   * Retags the saved images, then recreates in one `up` the services whose stack was running before their update.
   * A point whose service has left the compose file is skipped. Returns the services started.
   */
  async restore(ctx: StackContext, points: PullPoint[]): Promise<string[]> {
    const { stack, log } = ctx;
    const services = await this.docker.composeServices(stack.dir);
    const started: string[] = [];
    for (const point of points) {
      if (!services.some((s) => s.name === point.service)) {
        log(`${point.service} n'est plus dans la stack : ignoré`);
        continue;
      }
      log(`== retour à l'image de ${point.service}`);
      await this.docker.tag(rollbackTag(stack.name, point.service), point.image);
      if (point.running) started.push(point.service);
    }
    if (started.length > 0) await runCompose(this.docker, ctx, ["up", "-d", "--no-deps", ...started]);
    return started;
  }
}
