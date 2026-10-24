import { join } from "node:path";
import type { ServiceKind, ServiceStatus, StackStatus, UpdateMode } from "@shared/updater-api";
import { find } from "remeda";
import { match } from "ts-pattern";
import { stackConfig, type StackConfig, type UpdaterConfig } from "./config";
import type { ComposeService, Docker, LogSink } from "./docker";
import { discoverStacks, type DiscoveredStack } from "./discovery";
import { readVariableFile } from "./env-file";
import { parseImageRef } from "./image-ref";
import type { Registry } from "./registry";
import type { RollbackState, Store } from "./store";
import { authentikTarget, isLiteralVersion, isMajorBump, newestAbove } from "./versions";

export type DetectionDeps = { docker: Docker; registry: Registry; now: () => Date };

type Checked = { status: ServiceStatus; authentikKind: "patch" | "minor" | null };

function kindOf(service: ComposeService, config: StackConfig): ServiceKind {
  const variable = config.version?.variable;
  if (variable && service.rawImage.includes(`\${${variable}`)) return "variable";
  if (service.image.includes("@sha256:")) return "pinned";
  return isLiteralVersion(parseImageRef(service.image).tag) ? "literal" : "floating";
}

async function checkService(
  service: ComposeService,
  config: StackConfig,
  { docker, registry }: DetectionDeps,
): Promise<Checked> {
  const kind = kindOf(service, config);
  const base: ServiceStatus = {
    name: service.name,
    image: service.image,
    kind,
    current: null,
    available: null,
    newImageDate: null,
    update: false,
    error: null,
  };
  const ref = parseImageRef(service.image);

  return match(kind)
    .with("pinned", async (): Promise<Checked> => ({ status: base, authentikKind: null }))
    .with("floating", async (): Promise<Checked> => {
      const local = await docker.image(service.image);
      if (!local) return { status: { ...base, error: "image locale introuvable" }, authentikKind: null };
      const remoteDigest = await registry.digest(ref);
      const update = !local.repoDigests.some((d) => d.endsWith(`@${remoteDigest}`));
      if (!update) return { status: base, authentikKind: null };
      const remote = await registry.details(ref);
      const status =
        local.version !== null && remote.version !== null
          ? { ...base, update, current: local.version, available: remote.version }
          : { ...base, update, newImageDate: remote.created };
      return { status, authentikKind: null };
    })
    .with("variable", "literal", async (): Promise<Checked> => {
      const tags = await registry.tags(ref);
      const target = config.recipe === "authentik" && kind === "variable" ? authentikTarget(ref.tag, tags) : null;
      const available =
        config.recipe === "authentik" && kind === "variable" ? (target?.to ?? null) : newestAbove(ref.tag, tags);
      return {
        status: { ...base, current: ref.tag, available, update: available !== null },
        authentikKind: target?.kind ?? null,
      };
    })
    .exhaustive();
}

async function safeCheckService(service: ComposeService, config: StackConfig, deps: DetectionDeps): Promise<Checked> {
  try {
    return await checkService(service, config, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: {
        name: service.name,
        image: service.image,
        kind: kindOf(service, config),
        current: null,
        available: null,
        newImageDate: null,
        update: false,
        error: message,
      },
      authentikKind: null,
    };
  }
}

export async function checkStack(
  stack: DiscoveredStack,
  config: StackConfig,
  rollback: RollbackState | null,
  deps: DetectionDeps,
): Promise<StackStatus> {
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
    rollback: rollback ? { to: rollback.to } : null,
    error: null,
    checkedAt: deps.now().toISOString(),
  };

  let services: ComposeService[];
  try {
    services = await deps.docker.composeServices(stack.dir);
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }

  const checked = await Promise.all(services.map((service) => safeCheckService(service, config, deps)));
  const statuses = checked.map((c) => c.status);
  const updated = checked.filter((c) => c.status.update);

  let current: string | null;
  let available: string | null;
  if (config.version) {
    current = await readVariableFile(join(stack.dir, config.version.file), config.version.variable).catch(() => null);
    available = find(statuses, (s) => s.kind === "variable")?.available ?? null;
  } else {
    const first = find(updated, (c) => c.status.current !== null && c.status.available !== null)?.status;
    current = first?.current ?? null;
    available = first?.available ?? null;
  }

  const major = current !== null && available !== null && isMajorBump(current, available);
  const authentikMinor = mode === "recipe" && updated.some((c) => c.authentikKind === "minor");

  return {
    ...base,
    services: statuses,
    update: updated.length > 0,
    button: updated.some((c) => c.status.kind !== "literal" && c.status.kind !== "pinned"),
    current,
    available,
    major,
    needsConfirm: config.confirm || major || authentikMinor,
  };
}

export async function checkAll(
  input: { root: string; config: UpdaterConfig; store: Store },
  deps: DetectionDeps,
  log: LogSink,
): Promise<StackStatus[]> {
  const { root, config, store } = input;
  const stacks = await discoverStacks(root, config.exclude);
  const list: StackStatus[] = [];
  for (const stack of stacks) {
    const status = await checkStack(stack, stackConfig(config, stack.name), store.rollback(stack.name), deps);
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
  store.saveStackStatuses(list);
  store.setMeta("lastCheck", deps.now().toISOString());
  return list;
}
