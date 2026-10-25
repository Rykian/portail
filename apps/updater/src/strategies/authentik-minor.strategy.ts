import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { createTwoFilesPatch } from "diff";
import { FETCH } from "../common/runtime";
import { DOCKER, type Docker } from "../docker/docker";
import { compareVersions } from "../docker/versions";
import { runCompose } from "../stacks/compose";
import { readVariableFile, writeFileAtomic, writeVariableFile } from "../stacks/env-file";
import { fail } from "../stacks/fail";
import type { StackContext } from "../stacks/stack-context";
import { notNewerMessage, type Plan, type RollbackOf, type UpdateStrategy } from "./strategy";

type Preview =
  | { ok: true; from: string; to: string; diff: string; upstreamTarget: string; localCompose: string }
  | { ok: false; error: string };

const LOCAL_MODIFICATIONS = "Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml";

export const upstreamComposeUrl = (minor: string): string =>
  `https://goauthentik.io/version/${minor}/lifecycle/container/compose.yml`;

export const normalizeCompose = (text: string): string =>
  text.replaceAll("\r", "").replace(/\$\{AUTHENTIK_TAG:-[^}]*\}/g, "${AUTHENTIK_TAG}");

export const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".");

async function fetchUpstream(
  minor: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await fetchFn(upstreamComposeUrl(minor), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    return { ok: false, error: `compose.yml amont introuvable pour ${minor} (HTTP ${response.status})` };
  }
  return { ok: true, text: await response.text() };
}

/** Moving to another Authentik minor: swaps compose.yml for upstream's, then rewrites the version variable. */
@Injectable()
export class AuthentikMinorStrategy implements UpdateStrategy<"recipe"> {
  readonly kind = "recipe";

  constructor(
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
    @Inject(DOCKER) private readonly docker: Docker,
  ) {}

  /** Fetches upstream's compose.yml for both minors and checks the local one is unmodified, or says why not. */
  private async plan({ stack, config, status }: StackContext): Promise<Preview> {
    const version = config.version ?? fail("configuration de version absente");
    const from = await readVariableFile(join(stack.dir, version.file), version.variable);
    if (from === null) fail(`variable ${version.variable} absente de ${version.file}`);
    const to = status.available ?? fail("aucune version disponible");
    if (compareVersions(to, from) <= 0) return { ok: false, error: notNewerMessage(to, from, version.file) };
    const currentMinor = minorOf(from);
    const targetMinor = minorOf(to);

    const current = await fetchUpstream(currentMinor, this.fetchFn);
    if (!current.ok) return current;
    const localCompose = await readFile(join(stack.dir, stack.composeFile), "utf8");
    if (normalizeCompose(localCompose) !== normalizeCompose(current.text)) {
      return { ok: false, error: LOCAL_MODIFICATIONS };
    }
    const target = await fetchUpstream(targetMinor, this.fetchFn);
    if (!target.ok) return target;

    const diff = createTwoFilesPatch(
      `compose.yml (${currentMinor})`,
      `compose.yml (${targetMinor})`,
      current.text,
      target.text,
    );
    return { ok: true, from, to, diff, upstreamTarget: target.text, localCompose };
  }

  async prepare(ctx: StackContext): Promise<Plan<"recipe">> {
    const { stack, config, log } = ctx;
    const version = config.version ?? fail("configuration de version absente");
    const plan = await this.plan(ctx);
    if (!plan.ok) return fail(plan.error);
    return {
      rollbackTo: plan.from,
      rollback: {
        kind: "recipe",
        file: version.file,
        variable: version.variable,
        value: plan.from,
        compose: plan.localCompose,
      },
      apply: async () => {
        log(`== ${stack.composeFile} amont ${plan.to}`);
        await writeFileAtomic(join(stack.dir, stack.composeFile), plan.upstreamTarget);
        log(`== ${version.variable}=${plan.to}`);
        await writeVariableFile(join(stack.dir, version.file), version.variable, plan.to);
      },
    };
  }

  /** The compose.yml diff the user confirms; fails with the reason when the update is not possible. */
  async preview(ctx: StackContext): Promise<string> {
    const plan = await this.plan(ctx);
    if (!plan.ok) return fail(plan.error);
    return plan.diff;
  }

  async restore(ctx: StackContext, data: RollbackOf<"recipe">, start: boolean): Promise<void> {
    const { stack, log } = ctx;
    log(`== restauration de ${stack.composeFile}`);
    await writeFileAtomic(join(stack.dir, stack.composeFile), data.compose);
    log(`== ${data.variable}=${data.value}`);
    await writeVariableFile(join(stack.dir, data.file), data.variable, data.value);
    if (start) await runCompose(this.docker, ctx, ["up", "-d", "--pull", "missing"]);
  }
}
