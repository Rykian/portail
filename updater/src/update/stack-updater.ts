import { Inject, Injectable } from "@nestjs/common";
import { DOCKER, isUp, type ContainerState, type Docker } from "../docker/docker";
import { runCompose } from "../stacks/compose";
import { fail } from "../stacks/fail";
import { RollbackStore } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { rollbackTag } from "../strategies/pull.strategy";
import { Strategies } from "../strategies/strategies";
import { WAIT_HEALTHY, type WaitHealthy } from "./health";

type Result = "success" | "failed";

const isStackUp = (before: ContainerState[]): boolean => before.some(isUp);

/** What every update shares around its strategy (rollback state, `before` commands, pull and start, health check). */
@Injectable()
export class StackUpdater {
  constructor(
    @Inject(DOCKER) private readonly docker: Docker,
    @Inject(RollbackStore) private readonly rollbacks: RollbackStore,
    @Inject(Strategies) private readonly strategies: Strategies,
    @Inject(WAIT_HEALTHY) private readonly wait: WaitHealthy,
  ) {}

  async update(ctx: StackContext): Promise<Result> {
    const { stack, config, status, log } = ctx;
    try {
      const before = await this.docker.containers(stack.dir);
      // Order matters: preparing may fail before any change, and the rollback is saved before anything is written.
      const plan = await this.strategies.forUpdate(status, config).prepare(ctx, before);
      if (plan.rollback.kind === "pull") await this.removeStaleRollbackTags(stack.name, plan.rollback.services);
      this.rollbacks.save({
        stack: stack.name,
        to: plan.rollbackTo,
        major: status.major,
        running: isStackUp(before),
        data: plan.rollback,
      });
      await this.runBeforeCommands(ctx);
      await plan.apply();
      await this.pullAndStart(ctx, before);
      return "success";
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  async rollback(ctx: StackContext): Promise<Result> {
    const { stack, log } = ctx;
    try {
      const state = this.rollbacks.get(stack.name);
      if (!state) return fail(`aucun état de retour arrière pour ${stack.name}`);
      // After a failed update, broken containers must come back too: treat them as expected to run.
      const before = (await this.docker.containers(stack.dir)).map((c) =>
        c.state === "running" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== 0)
          ? { ...c, state: "running" as const }
          : c,
      );
      await this.strategies.restore(ctx, state.data, state.running);
      if (state.running) await this.checkHealth(ctx, before);
      else log("pile arrêtée avant la mise à jour : retour arrière fait, pile laissée arrêtée");
      if (state.data.kind === "pull") {
        for (const saved of state.data.services) await this.docker.removeImage(rollbackTag(stack.name, saved.service));
      }
      this.rollbacks.delete(stack.name);
      return "success";
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  /** The previous pull rollback tagged images of services that have left the stack: untag them. */
  private async removeStaleRollbackTags(project: string, saved: { service: string }[]): Promise<void> {
    const previous = this.rollbacks.get(project);
    if (previous?.data.kind !== "pull") return;
    for (const old of previous.data.services) {
      if (!saved.some((s) => s.service === old.service)) {
        await this.docker.removeImage(rollbackTag(project, old.service));
      }
    }
  }

  private async runBeforeCommands(ctx: StackContext): Promise<void> {
    const { stack, config, status, log } = ctx;
    const runBefore =
      config.before.length > 0 &&
      (!config.beforeOnlyOnMajor || status.major || status.current === null || status.available === null);
    if (!runBefore) return;
    for (const command of config.before) {
      log(`== before: ${command}`);
      const code = await this.docker.shell(stack.dir, command, log);
      if (code !== 0) fail(`la commande before a échoué (code ${code}) : ${command}`);
    }
  }

  /** Pulls, then starts the stack and checks its health, unless nothing of it was running: a stopped stack stays stopped. */
  private async pullAndStart(ctx: StackContext, before: ContainerState[]): Promise<void> {
    await runCompose(this.docker, ctx, ["pull"]);
    if (!isStackUp(before)) {
      ctx.log("pile arrêtée : images téléchargées, pile laissée arrêtée");
      return;
    }
    await runCompose(this.docker, ctx, ["up", "-d"]);
    await this.checkHealth(
      ctx,
      before.map((c) => (isUp(c) ? { ...c, state: "running" as const } : c)),
    );
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
