import { Inject, Injectable } from "@nestjs/common";
import {
  MIGRATION_WARNING,
  type ImageProgress,
  type Job,
  type JobStep,
  type RollbackBody,
  type StackStatus,
  type UpdateBody,
  type UpdateResponse,
} from "@portail/shared/updater-api";
import { unique } from "remeda";
import { BadRequestError, ConflictError, messageOf, NotFoundError } from "../common/errors";
import { ENV, type Env } from "../common/runtime";
import { stackConfig, type StackConfig, type UpdaterConfig } from "../config/config";
import { ConfigService } from "../config/config.service";
import { DetectionService } from "../detection/detection.service";
import type { LogSink } from "../docker/docker";
import { JobRunner } from "../jobs/job-runner";
import { discoverStacks, type DiscoveredStack } from "../stacks/discovery";
import { RollbackStore } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { StackStatusStore } from "../stacks/stack-status.store";
import { selectableServices, selectionMajor, Strategies } from "../strategies/strategies";
import { StackUpdater } from "./stack-updater";
import { pinTarget, staleReason, type PinnedTarget } from "./target";
import { planUpdateAll, runUpdateAll } from "./update-all";

type Result = "success" | "failed";

/** What a user can ask for: a single update (confirmed first when needed), a rollback, or every update at once. */
@Injectable()
export class UpdateService {
  /** Failed updates and rollbacks per stack: a job queued before one of them must not run on what it left behind. */
  private readonly failures = new Map<string, number>();

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

  /** Starts or queues the update, or answers what the user must confirm first (with the compose diff when there is one). */
  async update(name: string, body: UpdateBody, user: string | null): Promise<UpdateResponse> {
    const { stack, status, config } = await this.lookup(name);
    if (!status.update || !status.button || status.error !== null) {
      throw new BadRequestError(`Aucune mise à jour applicable pour ${name}`);
    }
    const cfg = stackConfig(config, name);
    const selection = this.selection(status, cfg, body.services);

    let diff: string | null = null;
    const ctx = this.context(
      stack,
      config,
      status,
      selection,
      () => {},
      () => {},
    );
    const strategy = this.strategies.forUpdate(status, ctx.config);
    if (strategy.preview) {
      try {
        diff = await strategy.preview(ctx);
      } catch (error) {
        throw new BadRequestError(messageOf(error));
      }
    }

    const { from, to } = this.fromTo(status, selection);
    if (this.needsConfirm(status, cfg, selection) && body.confirm !== true) {
      return {
        needsConfirm: {
          from,
          to,
          diff,
          warning: status.confirm || status.recipe !== null ? MIGRATION_WARNING : null,
        },
      };
    }

    const step: JobStep = { stack: name, status: "pending", from, to, ...(selection ? { services: selection } : {}) };
    const pinned = pinTarget(status, selection, body.confirm === true);
    const failures = this.failureCount(name);
    const job = this.jobs.start(
      { kind: "update", user, steps: [step], targets: [{ stack: name, services: selection }] },
      (job) => this.singleStep(job.setSteps, step, () => this.runUpdate(name, job.log, job.progress, pinned, failures)),
    );
    return { jobId: job.id };
  }

  /** Rolls back one service's point, or everything the stack can roll back; never queued behind work on that stack. */
  async rollback(name: string, body: RollbackBody, user: string | null): Promise<Job> {
    const { status } = await this.lookup(name);
    // The point restored must be the one the user saw: a job on this stack could replace it before the rollback runs.
    if (this.jobs.pending().some((job) => job.targets.some((target) => target.stack === name))) {
      throw new ConflictError(`Une tâche est déjà prévue pour ${name}, attends qu'elle se termine`);
    }
    const service = body.service ?? null;
    const saved = service === null ? this.rollbacks.get(name) : null;
    const points = saved ? [] : this.rollbacks.points(name).filter((p) => service === null || p.service === service);
    if (!saved && points.length === 0) {
      throw new BadRequestError(
        `Aucun retour arrière disponible pour ${service === null ? name : `${name}/${service}`}`,
      );
    }
    const step: JobStep = {
      stack: name,
      status: "pending",
      from: service === null ? status.current : (status.services.find((s) => s.name === service)?.current ?? null),
      to: saved?.to ?? points.map((p) => p.to).join(", "),
      ...(saved ? {} : { services: points.map((p) => p.service) }),
    };
    return this.jobs.start(
      {
        kind: "rollback",
        user,
        steps: [step],
        targets: [{ stack: name, services: service === null ? null : [service] }],
      },
      (ctx) => this.singleStep(ctx.setSteps, step, () => this.runRollback(name, service, ctx.log)),
    );
  }

  /** Queues every applicable update; each stack's target is pinned now, as for a single update. */
  async updateAll(user: string | null): Promise<Job> {
    const statuses = this.statuses.stackStatuses();
    const { config } = await this.config.load();
    const planned = planUpdateAll(statuses).flatMap((name) => {
      const status = statuses.find((s) => s.name === name)!;
      const cfg = stackConfig(config, name);
      const selection = this.selection(status, cfg, undefined);
      // No confirmation is asked here: a stack whose targeted services need one is left out, like any stack that does.
      if (this.needsConfirm(status, cfg, selection)) return [];
      const { from, to } = this.fromTo(status, selection);
      const step: JobStep = { stack: name, status: "pending", from, to, ...(selection ? { services: selection } : {}) };
      return [
        {
          step,
          pinned: pinTarget(status, selection, false),
          failures: this.failureCount(name),
          target: { stack: name, services: selection },
        },
      ];
    });
    if (planned.length === 0) throw new BadRequestError("Aucune mise à jour à appliquer");
    const queue = planned.map((p) => p.pinned.stack);
    const steps = planned.map((p) => p.step);
    const targets = planned.map((p) => p.target);
    return this.jobs.start({ kind: "update-all", user, steps, targets }, (ctx) =>
      runUpdateAll(
        queue,
        (name, log) => {
          const { pinned, failures } = planned.find((p) => p.pinned.stack === name)!;
          return this.runUpdate(name, log, ctx.progress, pinned, failures);
        },
        ctx,
        steps,
      ),
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

  private context(
    stack: DiscoveredStack,
    config: UpdaterConfig,
    status: StackStatus,
    selection: string[] | null,
    log: LogSink,
    progress: (p: ImageProgress) => void,
  ): StackContext {
    return { stack, config: stackConfig(config, stack.name), status, selection, log, progress };
  }

  /**
   * The services a request targets: the ones named (all selectable, or 400), else every selectable service of a
   * pull-style stack, else null (version/recipe update of the whole stack).
   */
  private selection(status: StackStatus, config: StackConfig, services: string[] | undefined): string[] | null {
    const selectable = selectableServices(status, config);
    if (services === undefined) return selectable.length > 0 ? selectable : null;
    if (selectable.length === 0) throw new BadRequestError(`Mise à jour par image impossible pour ${status.name}`);
    if (services.length === 0) throw new BadRequestError(`Aucune image sélectionnée pour ${status.name}`);
    const unknown = services.find((s) => !selectable.includes(s));
    if (unknown !== undefined) throw new BadRequestError(`Service non sélectionnable : ${unknown}`);
    return unique(services);
  }

  /** A selection is judged on its own services: the stack-level values may come from a service that is not selected. */
  private needsConfirm(status: StackStatus, config: StackConfig, selection: string[] | null): boolean {
    return selection === null ? status.needsConfirm : config.confirm || selectionMajor(status, selection);
  }

  /** Shown on the confirmation and the step: one service's versions, or the names of the selected services. */
  private fromTo(status: StackStatus, selection: string[] | null): { from: string | null; to: string | null } {
    if (selection === null) return { from: status.current, to: status.available };
    if (selection.length === 1) {
      const service = status.services.find((s) => s.name === selection[0]);
      return { from: service?.current ?? null, to: service?.available ?? null };
    }
    return { from: null, to: selection.join(", ") };
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

  /**
   * Runs one stack's update with fresh config and status, then re-checks it on success. What runs is what was pinned
   * at queue time: nothing when it is already done, a failure when the target changed or now needs a confirmation.
   */
  private async runUpdate(
    name: string,
    log: LogSink,
    progress: (p: ImageProgress) => void,
    pinned: PinnedTarget,
    failures: number,
  ): Promise<Result> {
    const { stack, status, config } = await this.lookup(name);
    const cfg = stackConfig(config, name);
    // A failed check reports nothing to update: that must not pass for "already done".
    const error =
      status.error ??
      status.services.find((s) => s.error !== null && pinned.services.some((p) => p.name === s.name))?.error;
    if (error != null) {
      log(`vérification en erreur : ${error} : relancer la mise à jour`);
      return "failed";
    }
    // Pinned services already brought up to date (e.g. by an earlier queued job) are left out.
    const selection =
      pinned.services.length === 0
        ? null
        : pinned.services.filter((p) => status.services.some((s) => s.name === p.name && s.update)).map((p) => p.name);
    if (selection === null ? !status.update : selection.length === 0) {
      log("rien à faire : déjà à jour");
      return "success";
    }
    // A failure may have left the new image running: tagging it now would replace the only way back to the old one.
    if (this.failureCount(name) !== failures) {
      log(`une tâche précédente sur ${name} a échoué : vérifier la stack puis relancer la mise à jour`);
      return "failed";
    }
    const stale = staleReason(pinned, status, this.needsConfirm(status, cfg, selection));
    if (stale !== null) {
      log(stale);
      return "failed";
    }
    const ctx = this.context(stack, config, status, selection, log, progress);
    const result = await this.recordFailure(name, () => this.updater.update(ctx));
    if (result === "success") await this.detection.recheck(stack, ctx.config);
    return result;
  }

  private async runRollback(name: string, service: string | null, log: LogSink): Promise<Result> {
    const { stack, status, config } = await this.lookup(name);
    const ctx = this.context(stack, config, status, null, log, () => {});
    const result = await this.recordFailure(name, () => this.updater.rollback(ctx, service));
    if (result === "success") await this.detection.recheck(stack, ctx.config);
    return result;
  }

  private failureCount(name: string): number {
    return this.failures.get(name) ?? 0;
  }

  /** Runs work that changes the stack and counts it when it fails or throws. */
  private async recordFailure(name: string, work: () => Promise<Result>): Promise<Result> {
    let result: Result = "failed";
    try {
      result = await work();
      return result;
    } finally {
      if (result === "failed") this.failures.set(name, this.failureCount(name) + 1);
    }
  }
}
