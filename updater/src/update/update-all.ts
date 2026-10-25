import { filter, map, partition, pipe, sortBy } from "remeda";
import type { JobStep, StackStatus } from "@shared/updater-api";
import type { LogSink } from "../docker/docker";
import type { JobContext } from "../jobs";

/** Stacks updated last: the ones with a `last` flag or a dedicated recipe. */
export function planUpdateAll(stacks: StackStatus[]): string[] {
  const [regular, deferred] = pipe(
    stacks,
    filter((stack) => stack.update && stack.button && !stack.needsConfirm && stack.error === null),
    sortBy([(stack) => stack.name, "asc"]),
    partition((stack) => !stack.last && stack.recipe === null),
  );
  return pipe(
    [...regular, ...deferred],
    map((stack) => stack.name),
  );
}

export async function runUpdateAll(
  queue: string[],
  run: (stack: string, log: LogSink) => Promise<"success" | "failed">,
  ctx: JobContext,
  steps: JobStep[],
): Promise<"success" | "failed"> {
  const current = steps.map((step) => ({ ...step }));
  const setStatus = (index: number, status: JobStep["status"]) => {
    current[index] = { ...current[index], status };
    ctx.setSteps([...current]);
  };

  for (const [index, stack] of queue.entries()) {
    setStatus(index, "running");
    let outcome: "success" | "failed";
    try {
      outcome = await run(stack, ctx.log);
    } catch (error) {
      ctx.log(error instanceof Error ? error.message : String(error));
      outcome = "failed";
    }
    setStatus(index, outcome);
    if (outcome === "failed") {
      for (let rest = index + 1; rest < queue.length; rest++) setStatus(rest, "not-started");
      return "failed";
    }
  }
  return "success";
}
