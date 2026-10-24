import { filter, groupBy, unique } from "remeda";
import { match } from "ts-pattern";
import type { ContainerState } from "./docker";

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

const label = (container: ContainerState): string =>
  match(container.state)
    .with("running", () =>
      match(container.health)
        .with("unhealthy", () => "unhealthy")
        .with("starting", () => "starting")
        .with("healthy", null, () => "running")
        .exhaustive(),
    )
    .with("exited", () => `exited (${container.exitCode})`)
    .with("restarting", "created", "paused", "removing", "dead", (state) => state)
    .exhaustive();

export function evaluateHealth(before: ContainerState[], after: ContainerState[]): HealthResult {
  const services = unique(
    filter(before, (container) => container.state === "running").map((container) => container.service),
  );
  const afterByService = groupBy(after, (container) => container.service);

  const problems = services.flatMap((service) => {
    const containers = afterByService[service] ?? [];
    if (containers.length === 0) return [`${service} : absent`];
    if (containers.some(isOk)) return [];
    return [`${service} : ${label(containers[0])}`];
  });

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
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
    const result = evaluateHealth(before, await read());
    if (result.ok) return result;
    if (now() - start >= timeoutMs) return result;
    await sleep(intervalMs);
  }
}
