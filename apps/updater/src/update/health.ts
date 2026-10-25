import { filter, groupBy, unique } from "remeda";
import { match } from "ts-pattern";
import type { ContainerState } from "../docker/docker";

export type HealthResult = { ok: true } | { ok: false; problems: string[] };

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const isOk = (container: ContainerState): boolean =>
  match(container.state)
    .with("running", () => container.health === null || container.health === "healthy")
    .with("exited", () => container.exitCode === 0)
    .with("created", "paused", "restarting", "removing", "dead", () => false)
    .exhaustive();

const label = (container: ContainerState, waitedSeconds?: number): string =>
  match(container.state)
    .with("running", () =>
      match(container.health)
        .with("unhealthy", () => "unhealthy")
        .with("starting", () =>
          waitedSeconds === undefined ? "encore en démarrage" : `encore en démarrage après ${waitedSeconds} s`,
        )
        .with("healthy", null, () => "running")
        .exhaustive(),
    )
    .with("exited", () => `exited (${container.exitCode})`)
    .with("restarting", "created", "paused", "removing", "dead", (state) => state)
    .exhaustive();

export function evaluateHealth(
  before: ContainerState[],
  after: ContainerState[],
  waitedSeconds?: number,
): HealthResult {
  const services = unique(
    filter(before, (container) => container.state === "running").map((container) => container.service),
  );
  const afterByService = groupBy(after, (container) => container.service);

  const problems = services.flatMap((service) => {
    const containers = afterByService[service] ?? [];
    if (containers.length === 0) return [`${service} : absent`];
    const firstFailing = containers.find((container) => !isOk(container));
    return firstFailing ? [`${service} : ${label(firstFailing, waitedSeconds)}`] : [];
  });

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

async function poll(
  read: () => Promise<ContainerState[]>,
  before: ContainerState[],
  waitedSeconds: number,
): Promise<HealthResult> {
  try {
    return evaluateHealth(before, await read(), waitedSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`docker : ${message}`] };
  }
}

export async function waitHealthy(
  read: () => Promise<ContainerState[]>,
  before: ContainerState[],
  options: WaitOptions = {},
): Promise<HealthResult> {
  const {
    timeoutMs = 60_000,
    intervalMs = 2_000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;

  const start = now();
  for (;;) {
    const result = await poll(read, before, timeoutMs / 1000);
    if (result.ok) return result;
    if (now() - start >= timeoutMs) return result;
    await sleep(intervalMs);
  }
}

export type WaitHealthy = typeof waitHealthy;

/** Injection token for the health wait, so tests can substitute it. */
export const WAIT_HEALTHY = Symbol("WAIT_HEALTHY");
