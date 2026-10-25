import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type {
  Job,
  ServiceKind,
  ServiceStatus,
  StackStatus,
  StacksResponse,
  UpdateMode,
} from "@portail/shared/updater-api";
import { find } from "remeda";
import { match } from "ts-pattern";
import { CLOCK, ENV, type Env } from "../common/runtime";
import { stackConfig, type StackConfig, type UpdaterConfig } from "../config/config";
import { ConfigService } from "../config/config.service";
import { DOCKER, type ComposeService, type Docker, type LogSink } from "../docker/docker";
import { parseImageRef } from "../docker/image-ref";
import { REGISTRY, type Registry } from "../docker/registry";
import { isLiteralVersion, isMajorBump } from "../docker/versions";
import { JobRunner } from "../jobs/job-runner";
import { discoverStacks, type DiscoveredStack } from "../stacks/discovery";
import { readVariableFile } from "../stacks/env-file";
import { RollbackStore } from "../stacks/rollback.store";
import { StackStatusStore } from "../stacks/stack-status.store";
import { Strategies } from "../strategies/strategies";

type Checked = { status: ServiceStatus; needsConfirm: boolean };

function kindOf(service: ComposeService, config: StackConfig): ServiceKind {
  const variable = config.version?.variable;
  if (variable && new RegExp(`\\$\\{${variable}[}:]`).test(service.rawImage)) return "variable";
  if (service.image.includes("@sha256:")) return "pinned";
  return isLiteralVersion(parseImageRef(service.image).tag) ? "literal" : "floating";
}

const baseStatus = (service: ComposeService, kind: ServiceKind): ServiceStatus => ({
  name: service.name,
  image: service.image,
  kind,
  current: null,
  available: null,
  newImageDate: null,
  update: false,
  error: null,
});

/** Looks for available updates: checks every stack's services against their registry and stores what it finds. */
@Injectable()
export class DetectionService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(DOCKER) private readonly docker: Docker,
    @Inject(REGISTRY) private readonly registry: Registry,
    @Inject(StackStatusStore) private readonly statuses: StackStatusStore,
    @Inject(RollbackStore) private readonly rollbacks: RollbackStore,
    @Inject(Strategies) private readonly strategies: Strategies,
    @Inject(JobRunner) private readonly jobs: JobRunner,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  stacks(): StacksResponse {
    return {
      stacks: this.statuses.stackStatuses().map((status) => this.withRollback(status)),
      lastCheck: this.statuses.getMeta("lastCheck"),
      configError: this.statuses.getMeta("configError"),
      runningJob: this.jobs.running(),
    };
  }

  /** Starts a check job: reloads the config, then checks every stack. */
  check(user: string | null): Job {
    return this.jobs.start({ kind: "check", user, steps: [] }, async ({ log }) => {
      const { config, error } = await this.config.load();
      this.statuses.setMeta("configError", error);
      if (error !== null) log(`configuration invalide, la précédente est utilisée : ${error}`);
      await this.checkAll(config, log);
      return "success";
    });
  }

  lastCheck(): string | null {
    return this.statuses.getMeta("lastCheck");
  }

  /** Checks every stack that is not excluded, then stores their statuses and the time of this check. */
  async checkAll(config: UpdaterConfig, log: LogSink): Promise<StackStatus[]> {
    const stacks = await discoverStacks(this.env.root, config.exclude);
    const list: StackStatus[] = [];
    for (const stack of stacks) {
      const status = await this.checkStack(stack, stackConfig(config, stack.name));
      list.push(status);
      const count = status.services.filter((s) => s.update).length;
      log(
        status.error !== null
          ? `${stack.name}: erreur ${status.error}`
          : count > 0
            ? `${stack.name}: ${count} mise${count > 1 ? "s" : ""} à jour`
            : `${stack.name}: à jour`,
      );
    }
    this.statuses.saveStackStatuses(list);
    this.statuses.setMeta("lastCheck", this.now().toISOString());
    return list;
  }

  async checkStack(stack: DiscoveredStack, config: StackConfig): Promise<StackStatus> {
    const rollback = this.rollbacks.get(stack.name);
    const mode: UpdateMode = config.recipe ? "recipe" : config.version ? "version" : "pull";
    const base: StackStatus = {
      name: stack.name,
      mode,
      confirm: config.confirm,
      last: config.last,
      recipe: config.recipe ?? null,
      services: [],
      update: false,
      button: false,
      current: null,
      available: null,
      major: false,
      needsConfirm: config.confirm,
      rollback: rollback ? { to: rollback.to, major: rollback.major } : null,
      error: null,
      checkedAt: this.now().toISOString(),
    };

    let services: ComposeService[];
    try {
      services = await this.docker.composeServices(stack.dir);
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }

    const checked = await Promise.all(services.map((service) => this.safeCheckService(service, config)));
    const statuses = checked.map((c) => c.status);
    const updated = checked.filter((c) => c.status.update);

    let current: string | null;
    let available: string | null;
    if (config.version) {
      try {
        current = await readVariableFile(join(stack.dir, config.version.file), config.version.variable);
      } catch (error) {
        return { ...base, services: statuses, error: error instanceof Error ? error.message : String(error) };
      }
      const variableService = find(statuses, (s) => s.kind === "variable");
      if (variableService?.error) return { ...base, services: statuses, error: variableService.error };
      available = variableService?.available ?? null;
    } else {
      const first = find(updated, (c) => c.status.current !== null && c.status.available !== null)?.status;
      current = first?.current ?? null;
      available = first?.available ?? null;
    }

    const major = current !== null && available !== null && isMajorBump(current, available);

    return {
      ...base,
      services: statuses,
      update: updated.length > 0,
      button: updated.some((c) => c.status.kind !== "literal" && c.status.kind !== "pinned"),
      current,
      available,
      major,
      needsConfirm: config.confirm || major || checked.some((c) => c.status.update && c.needsConfirm),
    };
  }

  /** Checks one stack again after an update or a rollback and stores its status. */
  async recheck(stack: DiscoveredStack, config: StackConfig): Promise<void> {
    this.statuses.saveStackStatus(await this.checkStack(stack, config));
  }

  /** The `rollbacks` table is the source of truth: the stored status only holds the state of the last check. */
  private withRollback(status: StackStatus): StackStatus {
    const saved = this.rollbacks.get(status.name);
    return { ...status, rollback: saved ? { to: saved.to, major: saved.major } : null };
  }

  private async checkService(service: ComposeService, config: StackConfig): Promise<Checked> {
    const kind = kindOf(service, config);
    const base = baseStatus(service, kind);
    const ref = parseImageRef(service.image);

    return match(kind)
      .with("pinned", async (): Promise<Checked> => ({ status: base, needsConfirm: false }))
      .with("floating", async (): Promise<Checked> => {
        const local = await this.docker.image(service.image);
        if (!local) return { status: { ...base, error: "image locale introuvable" }, needsConfirm: false };
        const remoteDigest = await this.registry.digest(ref);
        const update = !local.repoDigests.some((d) => d.endsWith(`@${remoteDigest}`));
        if (!update) return { status: base, needsConfirm: false };
        const remote = await this.registry.details(ref);
        const status =
          local.version !== null && remote.version !== null
            ? { ...base, update, current: local.version, available: remote.version }
            : { ...base, update, newImageDate: remote.created };
        return { status, needsConfirm: false };
      })
      .with("variable", "literal", async (): Promise<Checked> => {
        const tags = await this.registry.tags(ref);
        const { to, needsConfirm } = this.strategies.target(config, kind, ref.tag, tags);
        return { status: { ...base, current: ref.tag, available: to, update: to !== null }, needsConfirm };
      })
      .exhaustive();
  }

  private async safeCheckService(service: ComposeService, config: StackConfig): Promise<Checked> {
    try {
      return await this.checkService(service, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: { ...baseStatus(service, kindOf(service, config)), error: message },
        needsConfirm: false,
      };
    }
  }
}
