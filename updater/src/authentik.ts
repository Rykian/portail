import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { readFile } from "node:fs/promises";
import { readVariableFile, writeFileAtomic, writeVariableFile } from "./env-file";
import { fail, notNewerMessage, pullAndStart, runBeforeCommands, type StackContext } from "./update";
import { compareVersions } from "./versions";

type Preview =
  | { ok: true; from: string; to: string; diff: string; upstreamTarget: string; localCompose: string }
  | { ok: false; error: string };

export type AuthentikPreview = { ok: true; from: string; to: string; diff: string } | { ok: false; error: string };

const LOCAL_MODIFICATIONS = "Des modifications locales sont dans compose.yml : les déplacer dans compose.override.yml";

export const upstreamComposeUrl = (minor: string): string =>
  `https://goauthentik.io/version/${minor}/lifecycle/container/compose.yml`;

export const normalizeCompose = (text: string): string =>
  text.replaceAll("\r", "").replace(/\$\{AUTHENTIK_TAG:-[^}]*\}/g, "${AUTHENTIK_TAG}");

const minorOf = (version: string): string => version.split(".").slice(0, 2).join(".");

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

async function prepare({ stack, config, status }: StackContext, fetchFn: typeof fetch): Promise<Preview> {
  const version = config.version ?? fail("configuration de version absente");
  const from = await readVariableFile(join(stack.dir, version.file), version.variable);
  if (from === null) fail(`variable ${version.variable} absente de ${version.file}`);
  const to = status.available ?? fail("aucune version disponible");
  if (compareVersions(to, from) <= 0) return { ok: false, error: notNewerMessage(to, from, version.file) };
  const currentMinor = minorOf(from);
  const targetMinor = minorOf(to);

  const current = await fetchUpstream(currentMinor, fetchFn);
  if (!current.ok) return current;
  const localCompose = await readFile(join(stack.dir, stack.composeFile), "utf8");
  if (normalizeCompose(localCompose) !== normalizeCompose(current.text)) {
    return { ok: false, error: LOCAL_MODIFICATIONS };
  }
  const target = await fetchUpstream(targetMinor, fetchFn);
  if (!target.ok) return target;

  const diff = createTwoFilesPatch(
    `compose.yml (${currentMinor})`,
    `compose.yml (${targetMinor})`,
    current.text,
    target.text,
  );
  return { ok: true, from, to, diff, upstreamTarget: target.text, localCompose };
}

export async function authentikPreview(
  ctx: StackContext,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<AuthentikPreview> {
  const result = await prepare(ctx, fetchFn);
  return result.ok ? { ok: true, from: result.from, to: result.to, diff: result.diff } : result;
}

export async function authentikMinorUpdate(
  ctx: StackContext,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<"success" | "failed"> {
  const { stack, config, store, docker, log } = ctx;
  try {
    const version = config.version ?? fail("configuration de version absente");
    const plan = await prepare(ctx, fetchFn);
    if (!plan.ok) return fail(plan.error);
    const before = await docker.containers(stack.name);

    store.saveRollback({
      stack: stack.name,
      to: plan.from,
      data: {
        kind: "recipe",
        file: version.file,
        variable: version.variable,
        value: plan.from,
        compose: plan.localCompose,
      },
    });
    await runBeforeCommands(ctx);

    log(`== ${stack.composeFile} amont ${plan.to}`);
    await writeFileAtomic(join(stack.dir, stack.composeFile), plan.upstreamTarget);
    log(`== ${version.variable}=${plan.to}`);
    await writeVariableFile(join(stack.dir, version.file), version.variable, plan.to);

    await pullAndStart(ctx, before);
    return "success";
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return "failed";
  }
}
