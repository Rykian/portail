import { Inject, Injectable } from "@nestjs/common";
import {
  MIGRATION_WARNING,
  type Job,
  type JobStep,
  type StackStatus,
  type UpdateBody,
  type UpdateResponse,
} from "@shared/updater-api";
import { BadRequestError, messageOf, NotFoundError } from "../common/errors";
import { ENV, type Env } from "../common/runtime";
import { stackConfig, type UpdaterConfig } from "../config/config";
import { ConfigService } from "../config/config.service";
import { DetectionService } from "../detection/detection.service";
import type { LogSink } from "../docker/docker";
import { JobRunner } from "../jobs/job-runner";
import { discoverStacks, type DiscoveredStack } from "../stacks/discovery";
import { RollbackStore } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { StackStatusStore } from "../stacks/stack-status.store";
import { Strategies } from "../strategies/strategies";
import { StackUpdater } from "./stack-updater";
import { planUpdateAll, runUpdateAll } from "./update-all";

type Result = "success" | "failed";

/** What a user can ask for: a single update (confirmed first when needed), a rollback, or every update at once. */
@Injectable()
export class UpdateService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(StackStatusStore) private readonly statuses: StackStatusStore,
    @Inject(RollbackStore) private readonly rollbacks: RollbackStore,
    @Inject(DetectionService) private readonly detection: DetectionService,
    @Inject(StackUpdater) private readonly updater: StackUpdater,
    @Inject(Strategies) private readonly strategies: Strategies,
    @Inject(JobRunner) private readonly jobs: JobRunner,
  ) {}

  /** Starts the update, or answers what the user must confirm first (with the compose diff when there is one). */
  async update(name: string, body: UpdateBody, user: string | null): Promise<UpdateResponse> {
    const { stack, status, config } = await this.lookup(name);
    if (!status.update || !status.button || status.error !== null) {
      throw new BadRequestError(`Aucune mise à jour applicable pour ${name}`);
    }

    let diff: string | null = null;
    const ctx = this.context(stack, config, status, () => {});
    const strategy = this.strategies.forUpdate(status, ctx.config);
    if (strategy.preview) {
      try {
        diff = await strategy.preview(ctx);
      } catch (error) {
        throw new BadRequestError(messageOf(error));
      }
    }

    if (status.needsConfirm && body.confirm !== true) {
      return {
        needsConfirm: {
          from: status.current,
          to: status.available,
          diff,
          warning: status.confirm || status.recipe !== null ? MIGRATION_WARNING : null,
        },
      };
    }

    const step: JobStep = { stack: name, status: "pending", from: status.current, to: status.available };
    const job = this.jobs.start({ kind: "update", user, steps: [step] }, (ctx) =>
      this.singleStep(ctx.setSteps, step, () => this.runUpdate(name, ctx.log)),
    );
    return { jobId: job.id };
  }

  async rollback(name: string, user: string | null): Promise<Job> {
    const { status } = await this.lookup(name);
    const saved = this.rollbacks.get(name);
    if (!saved) throw new BadRequestError(`Aucun retour arrière disponible pour ${name}`);
    const step: JobStep = { stack: name, status: "pending", from: status.current, to: saved.to };
    return this.jobs.start({ kind: "rollback", user, steps: [step] }, (ctx) =>
      this.singleStep(ctx.setSteps, step, () => this.runRollback(name, ctx.log)),
    );
  }

  updateAll(user: string | null): Job {
    const statuses = this.statuses.stackStatuses();
    const queue = planUpdateAll(statuses);
    if (queue.length === 0) throw new BadRequestError("Aucune mise à jour à appliquer");
    const steps: JobStep[] = queue.map((name) => {
      const status = statuses.find((s) => s.name === name);
      return { stack: name, status: "pending", from: status?.current ?? null, to: status?.available ?? null };
    });
    return this.jobs.start({ kind: "update-all", user, steps }, (ctx) =>
      runUpdateAll(queue, (name, log) => this.runUpdate(name, log), ctx, steps),
    );
  }

  /** A stack's last stored status with its current config and directory; an unknown stack is a NotFoundError. */
  private async lookup(name: string): Promise<{ stack: DiscoveredStack; status: StackStatus; config: UpdaterConfig }> {
    const status = this.statuses.stackStatuses().find((s) => s.name === name);
    const { config } = await this.config.load();
    const stack = (await discoverStacks(this.env.root, config.exclude)).find((s) => s.name === name);
    if (!status || !stack) throw new NotFoundError(`Stack inconnue : ${name}`);
    return { stack, status, config };
  }

  private context(stack: DiscoveredStack, config: UpdaterConfig, status: StackStatus, log: LogSink): StackContext {
    return { stack, config: stackConfig(config, stack.name), status, log };
  }

  /** Shows the one step of a job as running while `run` works, then as its result. */
  private async singleStep(
    setSteps: (steps: JobStep[]) => void,
    step: JobStep,
    run: () => Promise<Result>,
  ): Promise<Result> {
    setSteps([{ ...step, status: "running" }]);
    let result: Result = "failed";
    try {
      result = await run();
    } finally {
      setSteps([{ ...step, status: result }]);
    }
    return result;
  }

  /** Runs one stack's update with fresh config and status, then re-checks it on success. */
  private async runUpdate(name: string, log: LogSink): Promise<Result> {
    const { stack, status, config } = await this.lookup(name);
    const ctx = this.context(stack, config, status, log);
    const result = await this.updater.update(ctx);
    if (result === "success") await this.detection.recheck(stack, ctx.config);
    return result;
  }

  private async runRollback(name: string, log: LogSink): Promise<Result> {
    const { stack, status, config } = await this.lookup(name);
    const ctx = this.context(stack, config, status, log);
    const result = await this.updater.rollback(ctx);
    if (result === "success") await this.detection.recheck(stack, ctx.config);
    return result;
  }
}
