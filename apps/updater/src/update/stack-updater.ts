import { Inject, Injectable } from "@nestjs/common";
import { DOCKER, isUp, type ComposeService, type ContainerState, type Docker } from "../docker/docker";
import { IMAGE_PULLER, type ImagePuller } from "../docker/engine";
import { runCompose } from "../stacks/compose";
import { fail } from "../stacks/fail";
import { RollbackStore } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { rollbackTag } from "../strategies/pull.strategy";
import { selectableServices, selectionMajor, Strategies } from "../strategies/strategies";
import type { Plan } from "../strategies/strategy";
import { WAIT_HEALTHY, type WaitHealthy } from "./health";

type Result = "success" | "failed";

const isStackUp = (before: ContainerState[]): boolean => before.some(isUp);

/** Like `compose pull`: services with `pull_policy` `build` or `never` are not downloaded. */
const isDownloaded = (service: ComposeService): boolean =>
  service.pullPolicy !== "build" && service.pullPolicy !== "never";

/** What every update shares around its strategy (rollback state, `before` commands, download and start, health check). */
@Injectable()
export class StackUpdater {
  constructor(
    @Inject(DOCKER) private readonly docker: Docker,
    @Inject(IMAGE_PULLER) private readonly puller: ImagePuller,
    @Inject(RollbackStore) private readonly rollbacks: RollbackStore,
    @Inject(Strategies) private readonly strategies: Strategies,
    @Inject(WAIT_HEALTHY) private readonly wait: WaitHealthy,
  ) {}

  async update(ctx: StackContext): Promise<Result> {
    const { stack, config, status, log } = ctx;
    try {
      const before = await this.docker.containers(stack.dir);
      const strategy = this.strategies.forUpdate(status, config);
      // A pull-style update without a selection targets the whole stack: every selectable service.
      const selection = strategy.kind === "pull" ? (ctx.selection ?? selectableServices(status, config)) : null;
      // Order matters: preparing may fail before any change, and the rollback is saved before anything is written.
      const plan = await strategy.prepare({ ...ctx, selection }, before);
      await this.saveRollback(ctx, plan, before);
      await this.runBeforeCommands(ctx);
      await plan.apply();
      await this.pullAndStart(ctx, plan, before);
      return "success";
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  /** Rolls back one service's point, or (`service` null) the stack-level rollback or else every point of the stack. */
  async rollback(ctx: StackContext, service: string | null): Promise<Result> {
    const { stack, log } = ctx;
    try {
      const state = service === null ? this.rollbacks.get(stack.name) : null;
      const points = state
        ? []
        : this.rollbacks.points(stack.name).filter((p) => service === null || p.service === service);
      if (!state && points.length === 0) {
        return fail(`aucun état de retour arrière pour ${service === null ? stack.name : `${stack.name}/${service}`}`);
      }
      // After a failed update, broken containers must come back too: treat them as expected to run.
      const before = (await this.docker.containers(stack.dir)).map((c) =>
        c.state === "running" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== 0)
          ? { ...c, state: "running" as const }
          : c,
      );
      if (state) {
        await this.strategies.restore(ctx, state.data, state.running);
        if (state.running) await this.checkHealth(ctx, before);
        else log("pile arrêtée avant la mise à jour : retour arrière fait, pile laissée arrêtée");
        this.rollbacks.delete(stack.name);
        return "success";
      }
      const started = await this.strategies.restorePoints(ctx, points);
      if (started.length > 0) await this.checkHealth(ctx, before);
      else if (points.some((p) => !p.running)) {
        log("pile arrêtée avant la mise à jour : retour arrière fait, pile laissée arrêtée");
      }
      await this.dropPoints(
        stack.name,
        points.map((p) => p.service),
      );
      return "success";
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  /**
   * A stack holds either pull points or a stack-level rollback, never both. A pull update replaces the points of its
   * services and drops those of services gone from the compose file; a version/recipe update replaces everything.
   */
  private async saveRollback(ctx: StackContext, plan: Plan, before: ContainerState[]): Promise<void> {
    const { stack, status } = ctx;
    const existing = this.rollbacks.points(stack.name).map((p) => p.service);
    if (plan.kind === "pull") {
      this.rollbacks.delete(stack.name);
      await this.dropPoints(
        stack.name,
        existing.filter((service) => !plan.services.some((s) => s.name === service)),
      );
      for (const point of plan.points) this.rollbacks.savePoint(point);
      return;
    }
    await this.dropPoints(stack.name, existing);
    this.rollbacks.save({
      stack: stack.name,
      to: plan.rollbackTo,
      major: status.major,
      running: isStackUp(before),
      data: plan.rollback,
    });
  }

  /** Removes the points of these services and untags their saved images. */
  private async dropPoints(project: string, services: string[]): Promise<void> {
    for (const service of services) {
      await this.docker.removeImage(rollbackTag(project, service));
      this.rollbacks.deletePoint(project, service);
    }
  }

  private async runBeforeCommands(ctx: StackContext): Promise<void> {
    const { stack, config, status, selection, log } = ctx;
    // A selection is judged on its own services: the stack-level values may come from a service that is not selected.
    const majorOrUnknown =
      selection === null
        ? status.major || status.current === null || status.available === null
        : selectionMajor(status, selection) ||
          status.services.some((s) => selection.includes(s.name) && (s.current === null || s.available === null));
    const runBefore = config.before.length > 0 && (!config.beforeOnlyOnMajor || majorOrUnknown);
    if (!runBefore) return;
    for (const command of config.before) {
      log(`== before: ${command}`);
      const code = await this.docker.shell(stack.dir, command, log);
      if (code !== 0) fail(`la commande before a échoué (code ${code}) : ${command}`);
    }
  }

  /**
   * Downloads the targeted images, then starts them and checks the stack's health, unless nothing of it was running:
   * a stopped stack stays stopped. Pull-style updates recreate only their services, others the whole stack.
   */
  private async pullAndStart(ctx: StackContext, plan: Plan, before: ContainerState[]): Promise<void> {
    // Version/recipe images are read after `apply`: they resolve from the variable just written.
    const targets =
      plan.kind === "pull"
        ? plan.services.filter((s) => plan.selection.includes(s.name))
        : await this.docker.composeServices(ctx.stack.dir);
    for (const service of targets.filter(isDownloaded)) await this.download(ctx, service);
    if (!isStackUp(before)) {
      ctx.log("pile arrêtée : images téléchargées, pile laissée arrêtée");
      return;
    }
    await runCompose(
      this.docker,
      ctx,
      plan.kind === "pull" ? ["up", "-d", "--no-deps", ...plan.selection] : ["up", "-d"],
    );
    await this.checkHealth(
      ctx,
      before.map((c) => (isUp(c) ? { ...c, state: "running" as const } : c)),
    );
  }

  /** Downloads one image, reporting its progress; one log line when it starts and one when it ends. */
  private async download(ctx: StackContext, service: ComposeService): Promise<void> {
    const { stack, log, progress } = ctx;
    const { image } = service;
    let downloaded = 0;
    let total = 0;
    log(`== téléchargement de ${image}`);
    const result = await this.puller.pull(
      image,
      service.platform,
      (d, t) => {
        downloaded = d;
        total = t;
        progress({ stack: stack.name, service: service.name, image, downloaded, total, state: "downloading" });
      },
      log,
    );
    const state = result === "up-to-date" ? "up-to-date" : "done";
    progress({ stack: stack.name, service: service.name, image, downloaded, total, state });
    log(result === "up-to-date" ? `${image} déjà à jour` : `${image} téléchargée`);
  }

  private async checkHealth(ctx: StackContext, before: ContainerState[]): Promise<void> {
    ctx.log("== vérification de santé");
    const result = await this.wait(() => this.docker.containers(ctx.stack.dir), before);
    if (!result.ok) {
      for (const problem of result.problems) ctx.log(problem);
      fail("la vérification de santé a échoué");
    }
  }
}
