import { expect, test, vi } from "vitest";
import type { JobStep, StackStatus } from "@shared/updater-api";
import type { JobContext } from "./jobs";
import { planUpdateAll, runUpdateAll } from "./update-all";

function stack(name: string, overrides: Partial<StackStatus> = {}): StackStatus {
  return {
    name,
    mode: "pull",
    confirm: false,
    last: false,
    recipe: null,
    services: [],
    update: true,
    button: true,
    current: "1.0.0",
    available: "1.0.1",
    major: false,
    needsConfirm: false,
    rollback: null,
    error: null,
    checkedAt: null,
    ...overrides,
  };
}

test("planUpdateAll keeps eligible stacks, plain first then last/recipe, each sorted by name", () => {
  const stacks = [
    stack("traefik", { last: true }),
    stack("stirling"),
    stack("frigate", { needsConfirm: true, confirm: true }),
    stack("authentik", { recipe: "authentik" }),
    stack("mealie", { major: true, needsConfirm: true }),
    stack("group-gate", { button: false }),
    stack("cloudflared", { last: true }),
    stack("downloads"),
  ];

  expect(planUpdateAll(stacks)).toEqual(["downloads", "stirling", "authentik", "cloudflared", "traefik"]);
});

test("runUpdateAll stops at the first failure and marks the rest not-started", async () => {
  const queue = ["downloads", "stirling", "authentik", "cloudflared", "traefik"];
  const steps: JobStep[] = queue.map((stackName) => ({
    stack: stackName,
    status: "pending",
    from: "1.0.0",
    to: "1.0.1",
  }));
  const setSteps = vi.fn<(steps: JobStep[]) => void>();
  const ctx = { id: 1, log: vi.fn(), setSteps } as unknown as JobContext;
  const run = vi.fn(async (stackName: string) => (stackName === "stirling" ? "failed" : "success")) as unknown as (
    stack: string,
    log: JobContext["log"],
  ) => Promise<"success" | "failed">;

  const result = await runUpdateAll(queue, run, ctx, steps);

  expect(result).toBe("failed");
  expect(run).toHaveBeenCalledTimes(2);
  const final = setSteps.mock.calls.at(-1)?.[0] ?? [];
  expect(final.map((step) => step.status)).toEqual(["success", "failed", "not-started", "not-started", "not-started"]);
  expect(steps.every((step) => step.status === "pending")).toBe(true);
});

test("runUpdateAll treats a throwing run as failed and logs the message", async () => {
  const queue = ["downloads", "stirling"];
  const steps: JobStep[] = queue.map((stackName) => ({ stack: stackName, status: "pending", from: null, to: null }));
  const log = vi.fn();
  const ctx = { id: 1, log, setSteps: vi.fn() } as unknown as JobContext;
  const run = vi.fn(async (stackName: string) => {
    if (stackName === "downloads") throw new Error("boom");
    return "success" as const;
  });

  const result = await runUpdateAll(queue, run, ctx, steps);

  expect(result).toBe("failed");
  expect(run).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
});
