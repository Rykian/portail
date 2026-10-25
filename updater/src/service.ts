import {
  MIGRATION_WARNING,
  type HistoryPage,
  type Job,
  type JobEvent,
  type JobStep,
  type StackStatus,
  type StacksResponse,
  type UpdateBody,
  type UpdateResponse,
} from "@shared/updater-api";
import { match } from "ts-pattern";
import { authentikMinorUpdate, authentikPreview } from "./authentik";
import { stackConfig, type UpdaterConfig } from "./config/config";
import { checkAll, checkStack, type DetectionDeps } from "./detection";
import { discoverStacks, type DiscoveredStack } from "./stacks/discovery";
import type { Docker, LogSink } from "./docker/docker";
import type { JobRunner } from "./jobs";
import type { Registry } from "./docker/registry";
import type { JobStore } from "./jobs/job.store";
import type { RollbackStore } from "./stacks/rollback.store";
import type { StackStatusStore } from "./stacks/stack-status.store";
import { rollbackStack, updateStack, type StackContext } from "./update";
import { planUpdateAll, runUpdateAll } from "./update/update-all";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export type UpdaterServiceDeps = {
  root: string;
  loadConfig: () => Promise<{ config: UpdaterConfig; error: string | null }>;
  docker: Docker;
  registry: Registry;
  statuses: StackStatusStore;
  rollbacks: RollbackStore;
  jobStore: JobStore;
  jobs: JobRunner;
  now: () => Date;
  fetch?: typeof fetch;
};

type Result = "success" | "failed";

const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".");

const isAuthentikMinor = (status: StackStatus): boolean =>
  status.mode === "recipe" &&
  status.needsConfirm &&
  status.current !== null &&
  status.available !== null &&
  minorOf(status.current) !== minorOf(status.available);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class UpdaterService {
  constructor(private readonly deps: UpdaterServiceDeps) {}

  stacks(): StacksResponse {
    const { statuses, jobs } = this.deps;
    return {
      stacks: statuses.stackStatuses().map((status) => this.withRollback(status)),
      lastCheck: statuses.getMeta("lastCheck"),
      configError: statuses.getMeta("configError"),
      runningJob: jobs.running(),
    };
  }

  check(user: string | null): Job {
    const { root, loadConfig, statuses, rollbacks, jobs } = this.deps;
    return jobs.start({ kind: "check", user, steps: [] }, async ({ log }) => {
      const { config, error } = await loadConfig();
      statuses.setMeta("configError", error);
      if (error !== null) log(`configuration invalide, la précédente est utilisée : ${error}`);
      await checkAll({ root, config, statuses, rollbacks }, this.detectionDeps(), log);
      return "success";
    });
  }

  async update(name: string, body: UpdateBody, user: string | null): Promise<UpdateResponse> {
    const { stack, status, config } = await this.lookup(name);
    if (!status.update || !status.button || status.error !== null) {
      throw new BadRequestError(`Aucune mise à jour applicable pour ${name}`);
    }

    let diff: string | null = null;
    if (isAuthentikMinor(status)) {
      const ctx = this.context(stack, config, status, () => {});
      let preview: Awaited<ReturnType<typeof authentikPreview>>;
      try {
        preview = await authentikPreview(ctx, this.deps.fetch);
      } catch (error) {
        throw new BadRequestError(messageOf(error));
      }
      if (!preview.ok) throw new BadRequestError(preview.error);
      diff = preview.diff;
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
    const job = this.deps.jobs.start({ kind: "update", user, steps: [step] }, (ctx) =>
      this.singleStep(ctx.setSteps, step, () => this.runUpdate(name, ctx.log)),
    );
    return { jobId: job.id };
  }

  async rollback(name: string, user: string | null): Promise<Job> {
    const { status } = await this.lookup(name);
    const saved = this.deps.rollbacks.get(name);
    if (!saved) throw new BadRequestError(`Aucun retour arrière disponible pour ${name}`);
    const step: JobStep = { stack: name, status: "pending", from: status.current, to: saved.to };
    return this.deps.jobs.start({ kind: "rollback", user, steps: [step] }, (ctx) =>
      this.singleStep(ctx.setSteps, step, () => this.runRollback(name, ctx.log)),
    );
  }

  updateAll(user: string | null): Job {
    const statuses = this.deps.statuses.stackStatuses();
    const queue = planUpdateAll(statuses);
    if (queue.length === 0) throw new BadRequestError("Aucune mise à jour à appliquer");
    const steps: JobStep[] = queue.map((name) => {
      const status = statuses.find((s) => s.name === name);
      return { stack: name, status: "pending", from: status?.current ?? null, to: status?.available ?? null };
    });
    return this.deps.jobs.start({ kind: "update-all", user, steps }, (ctx) =>
      runUpdateAll(queue, (name, log) => this.runUpdate(name, log), ctx, steps),
    );
  }

  job(id: number): Job | null {
    return this.deps.jobStore.job(id);
  }

  events(id: number): AsyncIterable<JobEvent> | null {
    return this.deps.jobs.events(id);
  }

  history(cursor: number | null): HistoryPage {
    return this.deps.jobStore.history(cursor);
  }

  /** The `rollbacks` table is the source of truth: the stored status only holds the state of the last check. */
  private withRollback(status: StackStatus): StackStatus {
    const saved = this.deps.rollbacks.get(status.name);
    return { ...status, rollback: saved ? { to: saved.to, major: saved.major } : null };
  }

  private detectionDeps(): DetectionDeps {
    const { docker, registry, now } = this.deps;
    return { docker, registry, now };
  }

  private async lookup(name: string): Promise<{ stack: DiscoveredStack; status: StackStatus; config: UpdaterConfig }> {
    const { root, loadConfig, statuses } = this.deps;
    const status = statuses.stackStatuses().find((s) => s.name === name);
    const { config } = await loadConfig();
    const stack = (await discoverStacks(root, config.exclude)).find((s) => s.name === name);
    if (!status || !stack) throw new NotFoundError(`Stack inconnue : ${name}`);
    return { stack, status, config };
  }

  private context(stack: DiscoveredStack, config: UpdaterConfig, status: StackStatus, log: LogSink): StackContext {
    const { docker, rollbacks } = this.deps;
    return { stack, config: stackConfig(config, stack.name), status, docker, rollbacks, log };
  }

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
    const result = await match(status.mode)
      .with("pull", "version", () => updateStack(ctx))
      .with("recipe", () => (isAuthentikMinor(status) ? authentikMinorUpdate(ctx, this.deps.fetch) : updateStack(ctx)))
      .exhaustive();
    if (result === "success") await this.recheck(stack, config);
    return result;
  }

  private async runRollback(name: string, log: LogSink): Promise<Result> {
    const { stack, status, config } = await this.lookup(name);
    const result = await rollbackStack(this.context(stack, config, status, log));
    if (result === "success") await this.recheck(stack, config);
    return result;
  }

  private async recheck(stack: DiscoveredStack, config: UpdaterConfig): Promise<void> {
    const { statuses, rollbacks } = this.deps;
    const status = await checkStack(
      stack,
      stackConfig(config, stack.name),
      rollbacks.get(stack.name),
      this.detectionDeps(),
    );
    statuses.saveStackStatus(status);
  }
}
