import { Database } from "bun:sqlite";
import { expect, test } from "vitest";
import type { JobEvent, JobStep } from "@shared/updater-api";
import { BusyError, JobRunner } from "./jobs";
import { Store } from "./store";

function setup() {
  const store = new Store(new Database(":memory:"));
  const runner = new JobRunner(store, () => new Date("2026-01-02T03:04:05.000Z"));
  return { store, runner };
}

const input = { kind: "update" as const, user: "me", steps: [] as JobStep[] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function collect(iterable: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const out: JobEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

test("second start while running throws BusyError; works after end", async () => {
  const { runner } = setup();
  const gate = deferred();
  const job = runner.start(input, async () => {
    await gate.promise;
    return "success";
  });
  expect(runner.running()).toBe(job.id);
  expect(() => runner.start(input, async () => "success")).toThrow(BusyError);
  gate.resolve();
  await runner.idle();
  expect(runner.running()).toBeNull();
  expect(() => runner.start(input, async () => "success")).not.toThrow();
  await runner.idle();
});

test("work that throws fails the job with the message as last log line", async () => {
  const { store, runner } = setup();
  const job = runner.start(input, async (ctx) => {
    ctx.log("before");
    throw new Error("boom");
  });
  await runner.idle();
  expect(store.job(job.id)?.status).toBe("failed");
  expect(store.job(job.id)?.endedAt).toBe("2026-01-02T03:04:05.000Z");
  expect(store.jobLog(job.id)).toEqual(["before", "boom"]);
});

test("events replays then follows without duplicates", async () => {
  const { runner } = setup();
  const first = deferred();
  const second = deferred();
  const job = runner.start(input, async (ctx) => {
    ctx.log("a");
    await first.promise;
    ctx.log("b");
    await second.promise;
    return "success";
  });
  const events = runner.events(job.id)!;
  const collected = collect(events);
  first.resolve();
  await Promise.resolve();
  second.resolve();
  expect(await collected).toEqual([
    { type: "log", line: "a" },
    { type: "log", line: "b" },
    { type: "end", status: "success" },
  ]);
});

test("events called after a was logged replays a then follows", async () => {
  const { runner } = setup();
  const gate = deferred();
  const job = runner.start(input, async (ctx) => {
    ctx.log("a");
    await gate.promise;
    ctx.log("b");
    return "success";
  });
  const collected = collect(runner.events(job.id)!);
  gate.resolve();
  expect(await collected).toEqual([
    { type: "log", line: "a" },
    { type: "log", line: "b" },
    { type: "end", status: "success" },
  ]);
});

test("events on a finished job replays then ends", async () => {
  const { runner } = setup();
  const step: JobStep = { stack: "s", status: "success", from: "1", to: "2" };
  const job = runner.start(input, async (ctx) => {
    ctx.log("a");
    ctx.setSteps([step]);
    return "failed";
  });
  await runner.idle();
  expect(await collect(runner.events(job.id)!)).toEqual([
    { type: "log", line: "a" },
    { type: "step", step },
    { type: "end", status: "failed" },
  ]);
});

test("setSteps emits only changed steps", async () => {
  const { runner } = setup();
  const gate = deferred();
  const s1: JobStep = { stack: "a", status: "pending", from: null, to: null };
  const s2: JobStep = { stack: "b", status: "pending", from: null, to: null };
  const job = runner.start({ ...input, steps: [s1, s2] }, async (ctx) => {
    ctx.setSteps([s1, s2]);
    await gate.promise;
    ctx.setSteps([{ ...s1, status: "running" }, s2]);
    return "success";
  });
  const collected = collect(runner.events(job.id)!);
  gate.resolve();
  const events = await collected;
  expect(events.filter((e) => e.type === "step")).toEqual([
    { type: "step", step: s1 },
    { type: "step", step: s2 },
    { type: "step", step: { ...s1, status: "running" } },
  ]);
});

test("events for unknown id is null", () => {
  expect(setup().runner.events(999)).toBeNull();
});

test("every log line is persisted", async () => {
  const { store, runner } = setup();
  const job = runner.start(input, async (ctx) => {
    ctx.log("x");
    ctx.log("y");
    return "success";
  });
  await runner.idle();
  expect(store.jobLog(job.id)).toEqual(["x", "y"]);
});

test("consumer breaking early does not leak or break the job", async () => {
  const { runner } = setup();
  const gate = deferred();
  const job = runner.start(input, async (ctx) => {
    ctx.log("a");
    await gate.promise;
    ctx.log("b");
    return "success";
  });
  for await (const _ of runner.events(job.id)!) break;
  gate.resolve();
  await runner.idle();
  expect(runner.running()).toBeNull();
});
