import { join } from "node:path";
import type { StackStatus } from "@shared/updater-api";
import { uniqueBy } from "remeda";
import { match } from "ts-pattern";
import type { StackConfig } from "./config";
import type { DiscoveredStack } from "./discovery";
import type { ComposeService, ContainerState, Docker, LogSink } from "./docker";
import { readVariableFile, writeFileAtomic, writeVariableFile } from "./env-file";
import { waitHealthy } from "./health";
import type { RollbackState, Store } from "./store";
import { compareVersions } from "./versions";

export type StackContext = {
  stack: DiscoveredStack;
  config: StackConfig;
  status: StackStatus;
  docker: Docker;
  store: Store;
  log: LogSink;
  wait?: typeof waitHealthy;
};

type Result = "success" | "failed";

class StepFailed extends Error {}

export function fail(message: string): never {
  throw new StepFailed(message);
}

export const rollbackTag = (project: string, service: string): string =>
  `updater-rollback/${project}-${service}:latest`;

export async function runCompose({ stack, docker, log }: StackContext, args: string[]): Promise<void> {
  log(`== docker compose ${args.join(" ")}`);
  const code = await docker.compose(stack.dir, args, log);
  if (code !== 0) fail(`docker compose ${args.join(" ")} a échoué (code ${code})`);
}

export async function checkHealth(ctx: StackContext, before: ContainerState[]): Promise<void> {
  ctx.log("== vérification de santé");
  const result = await (ctx.wait ?? waitHealthy)(() => ctx.docker.containers(ctx.stack.name), before);
  if (!result.ok) {
    for (const problem of result.problems) ctx.log(problem);
    fail("la vérification de santé a échoué");
  }
}

export const notNewerMessage = (target: string, value: string, file: string): string =>
  `la version ${target} n'est pas plus récente que ${value} déjà dans ${file} : mise à jour annulée`;

/** Pulls, then starts the stack and checks its health, unless nothing of it was running: a stopped stack stays stopped. */
export async function pullAndStart(ctx: StackContext, before: ContainerState[]): Promise<void> {
  await runCompose(ctx, ["pull"]);
  if (!before.some((container) => container.state === "running")) {
    ctx.log("pile arrêtée : images téléchargées, pile laissée arrêtée");
    return;
  }
  await runCompose(ctx, ["up", "-d"]);
  await checkHealth(ctx, before);
}

async function savePullRollback(
  ctx: StackContext,
  services: ComposeService[],
  before: ContainerState[],
  to: string,
): Promise<void> {
  const { stack, docker, store } = ctx;
  const candidates = uniqueBy(
    before.filter((c) => c.state === "running"),
    (c) => c.service,
  ).flatMap((container) => {
    const service = services.find((s) => s.name === container.service);
    // Docker refuses to tag an image onto a digest reference: pinned services cannot be rolled back.
    return service && !service.image.includes("@sha256:") ? [{ container, service }] : [];
  });
  const saved: { service: string; image: string }[] = [];
  for (const { container, service } of candidates) {
    await docker.tag(container.imageId, rollbackTag(stack.name, service.name));
    saved.push({ service: service.name, image: service.image });
  }
  const previous = store.rollback(stack.name);
  if (previous?.data.kind === "pull") {
    for (const old of previous.data.services) {
      if (!saved.some((s) => s.service === old.service)) {
        await docker.removeImage(rollbackTag(stack.name, old.service));
      }
    }
  }
  store.saveRollback({ stack: stack.name, to, data: { kind: "pull", services: saved } });
}

export async function runBeforeCommands(ctx: StackContext): Promise<void> {
  const { stack, config, status, docker, log } = ctx;
  const runBefore =
    config.before.length > 0 &&
    (!config.beforeOnlyOnMajor || status.major || status.current === null || status.available === null);
  if (!runBefore) return;
  for (const command of config.before) {
    log(`== before: ${command}`);
    const code = await docker.shell(stack.dir, command, log);
    if (code !== 0) fail(`la commande before a échoué (code ${code}) : ${command}`);
  }
}

export async function updateStack(ctx: StackContext): Promise<Result> {
  const { stack, config, status, docker, store, log } = ctx;
  try {
    const services = await docker.composeServices(stack.dir);
    const before = await docker.containers(stack.name);
    const versionFile = match(status.mode)
      .with("pull", () => null)
      .with("version", "recipe", () => config.version ?? fail("configuration de version absente"))
      .exhaustive();

    // Version or recipe mode without a variable target (only a floating sidecar changed) updates like pull mode.
    const target = versionFile === null ? null : status.available;

    if (versionFile === null || target === null) {
      await savePullRollback(
        ctx,
        services,
        before,
        (status.mode === "pull" ? status.current : null) ?? "l'image précédente",
      );
    } else {
      const value = await readVariableFile(join(stack.dir, versionFile.file), versionFile.variable);
      if (value === null) fail(`variable ${versionFile.variable} absente de ${versionFile.file}`);
      if (compareVersions(target, value) <= 0) fail(notNewerMessage(target, value, versionFile.file));
      store.saveRollback({
        stack: stack.name,
        to: value,
        data: { kind: "version", file: versionFile.file, variable: versionFile.variable, value },
      });
    }

    await runBeforeCommands(ctx);

    if (versionFile !== null && target !== null) {
      log(`== ${versionFile.variable}=${target}`);
      await writeVariableFile(join(stack.dir, versionFile.file), versionFile.variable, target);
    }

    await pullAndStart(ctx, before);
    return "success";
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

async function restore(ctx: StackContext, state: RollbackState): Promise<void> {
  const { stack, docker, log } = ctx;
  await match(state.data)
    .with({ kind: "pull" }, async (data) => {
      for (const saved of data.services) {
        log(`== retour à l'image de ${saved.service}`);
        await docker.tag(rollbackTag(stack.name, saved.service), saved.image);
      }
      await runCompose(ctx, ["up", "-d"]);
    })
    .with({ kind: "version" }, async (data) => {
      log(`== ${data.variable}=${data.value}`);
      await writeVariableFile(join(stack.dir, data.file), data.variable, data.value);
      await runCompose(ctx, ["up", "-d", "--pull", "missing"]);
    })
    .with({ kind: "recipe" }, async (data) => {
      log(`== restauration de ${stack.composeFile}`);
      await writeFileAtomic(join(stack.dir, stack.composeFile), data.compose);
      log(`== ${data.variable}=${data.value}`);
      await writeVariableFile(join(stack.dir, data.file), data.variable, data.value);
      await runCompose(ctx, ["up", "-d", "--pull", "missing"]);
    })
    .exhaustive();
}

export async function rollbackStack(ctx: StackContext): Promise<Result> {
  const { stack, docker, store, log } = ctx;
  try {
    const state = store.rollback(stack.name);
    if (!state) return fail(`aucun état de retour arrière pour ${stack.name}`);
    // After a failed update, broken containers must come back too: treat them as expected to run.
    const before = (await docker.containers(stack.name)).map((c) =>
      c.state === "running" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== 0)
        ? { ...c, state: "running" as const }
        : c,
    );
    await restore(ctx, state);
    await checkHealth(ctx, before);
    if (state.data.kind === "pull") {
      for (const saved of state.data.services) await docker.removeImage(rollbackTag(stack.name, saved.service));
    }
    store.deleteRollback(stack.name);
    return "success";
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}
