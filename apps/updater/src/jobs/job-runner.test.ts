import { expect, test } from "vitest";
import type { ImageProgress, JobEvent, JobStep, JobTarget } from "@portail/shared/updater-api";
import { openDatabase } from "../database/database";
import { JobRunner } from "./job-runner";
import { JobStore } from "./job.store";

function setup() {
  const store = new JobStore(openDatabase(":memory:"));
  const runner = new JobRunner(store, () => new Date("2026-01-02T03:04:05.000Z"));
  return { store, runner };
}

const input = { kind: "update" as const, user: "me", steps: [] as JobStep[], targets: [] as JobTarget[] };

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

/** A runner whose clock is set by the test. */
function setupClock(start: string) {
  const store = new JobStore(openDatabase(":memory:"));
  const clock = { now: Date.parse(start) };
  const runner = new JobRunner(store, () => new Date(clock.now));
  return { store, runner, clock };
}

test("a second start while running is queued, then runs after the first", async () => {
  const { store, runner } = setup();
  const gate = deferred();
  const record: string[] = [];
  const targetA: JobTarget[] = [{ stack: "a", services: null }];
  const targetB: JobTarget[] = [{ stack: "b", services: ["server"] }];
  const a = runner.start({ ...input, targets: targetA }, async () => {
    record.push("a:start");
    await gate.promise;
    record.push("a:end");
    return "success";
  });
  const b = runner.start({ ...input, kind: "rollback", targets: targetB }, async () => {
    record.push("b");
    return "success";
  });
  expect(a.status).toBe("running");
  expect(b.status).toBe("queued");
  expect(store.job(b.id)?.status).toBe("queued");
  expect(runner.running()).toBe(a.id);
  expect(runner.busy()).toBe(true);
  expect(runner.pending()).toEqual([
    { id: a.id, kind: "update", status: "running", targets: targetA },
    { id: b.id, kind: "rollback", status: "queued", targets: targetB },
  ]);
  gate.resolve();
  await runner.idle();
  expect(store.job(a.id)?.status).toBe("success");
  expect(store.job(b.id)?.status).toBe("success");
  expect(record).toEqual(["a:start", "a:end", "b"]);
  expect(runner.pending()).toEqual([]);
  expect(runner.busy()).toBe(false);
});

test("queued jobs run in FIFO order", async () => {
  const { runner } = setup();
  const gate = deferred();
  const order: string[] = [];
  runner.start(input, async () => {
    order.push("a");
    await gate.promise;
    return "success";
  });
  for (const name of ["b", "c"]) {
    runner.start(input, async () => {
      order.push(name);
      return "success";
    });
  }
  expect(order).toEqual(["a"]);
  gate.resolve();
  await runner.idle();
  expect(order).toEqual(["a", "b", "c"]);
});

test("a queued job's startedAt is set when it starts", async () => {
  const t1 = "2026-01-02T03:04:05.000Z";
  const t2 = "2026-01-02T03:10:00.000Z";
  const { store, runner, clock } = setupClock(t1);
  const gate = deferred();
  runner.start(input, async () => {
    await gate.promise;
    return "success";
  });
  const b = runner.start(input, async () => "success");
  expect(store.job(b.id)?.startedAt).toBe(t1);
  clock.now = Date.parse(t2);
  gate.resolve();
  await runner.idle();
  expect(store.job(b.id)?.startedAt).toBe(t2);
});

test("following a queued job waits for it to run", async () => {
  const { runner } = setup();
  const gate = deferred();
  runner.start(input, async () => {
    await gate.promise;
    return "success";
  });
  const b = runner.start(input, async (ctx) => {
    ctx.log("x");
    return "success";
  });
  const collected = collect(runner.events(b.id)!);
  expect(runner.listenerCount(b.id)).toBe(1);
  gate.resolve();
  expect(await collected).toEqual([
    { type: "log", line: "x" },
    { type: "end", status: "success" },
  ]);
});

test("progress is relayed, throttled, not logged and replayed to late followers", async () => {
  const t0 = Date.parse("2026-01-02T03:04:05.000Z");
  const { store, runner, clock } = setupClock(new Date(t0).toISOString());
  const begin = deferred();
  const gate = deferred();
  const step: JobStep = { stack: "s", status: "running", from: null, to: null };
  const image = (service: string, downloaded: number, state: ImageProgress["state"]): ImageProgress => ({
    stack: "s",
    service,
    image: `${service}:1`,
    downloaded,
    total: 100,
    state,
  });
  const job = runner.start({ ...input, steps: [step] }, async (ctx) => {
    ctx.log("pull");
    await begin.promise;
    // Ten updates of one image within 100 ms: only the first goes out, then the state change.
    for (let i = 0; i < 10; i++) {
      clock.now = t0 + i * 10;
      ctx.progress(image("a", i * 10, "downloading"));
    }
    ctx.progress(image("a", 100, "done"));
    // Another image: a second update 300 ms later goes out too.
    clock.now = t0;
    ctx.progress(image("b", 10, "downloading"));
    clock.now = t0 + 300;
    ctx.progress(image("b", 40, "downloading"));
    await gate.promise;
    return "success";
  });
  const early = collect(runner.events(job.id)!);
  begin.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const late = collect(runner.events(job.id)!);
  gate.resolve();
  await runner.idle();

  const progressOf = (events: JobEvent[]) => events.filter((e) => e.type === "progress").map((e) => e.progress);
  expect(progressOf(await early)).toEqual([
    image("a", 0, "downloading"),
    image("a", 100, "done"),
    image("b", 10, "downloading"),
    image("b", 40, "downloading"),
  ]);
  expect(await late).toEqual([
    { type: "log", line: "pull" },
    { type: "step", step },
    { type: "progress", progress: image("a", 100, "done") },
    { type: "progress", progress: image("b", 40, "downloading") },
    { type: "end", status: "success" },
  ]);
  expect(store.jobLog(job.id)).toEqual(["pull"]);
  // Once the job has ended, progress is no longer replayed.
  expect(progressOf(await collect(runner.events(job.id)!))).toEqual([]);
});

test("idle waits for the queue to drain", async () => {
  const { runner } = setup();
  const first = deferred();
  const second = deferred();
  runner.start(input, async () => {
    await first.promise;
    return "success";
  });
  const b = runner.start(input, async () => {
    await second.promise;
    return "success";
  });
  let idle = false;
  const waiting = runner.idle().then(() => (idle = true));
  first.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runner.running()).toBe(b.id);
  expect(idle).toBe(false);
  second.resolve();
  await waiting;
  expect(idle).toBe(true);
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

test("events subscribed after a, then b logged, gives exactly a, b, end", async () => {
  const { runner } = setup();
  const gate = deferred();
  const job = runner.start(input, async (ctx) => {
    ctx.log("a");
    await gate.promise;
    ctx.log("b");
    return "success";
  });
  const collected = collect(runner.events(job.id)!);
  expect(runner.listenerCount(job.id)).toBe(1);
  gate.resolve();
  expect(await collected).toEqual([
    { type: "log", line: "a" },
    { type: "log", line: "b" },
    { type: "end", status: "success" },
  ]);
  expect(runner.listenerCount(job.id)).toBe(0);
});

test("return() while next() is pending unsubscribes immediately", async () => {
  const { runner } = setup();
  const gate = deferred();
  const job = runner.start(input, async () => {
    await gate.promise;
    return "success";
  });
  const it = runner.events(job.id)![Symbol.asyncIterator]();
  const pending = it.next();
  expect(runner.listenerCount(job.id)).toBe(1);
  await it.return!();
  expect(runner.listenerCount(job.id)).toBe(0);
  expect((await pending).done).toBe(true);
  gate.resolve();
  await runner.idle();
});

function failingStore(method: "appendLog" | "finishJob") {
  const store = new JobStore(openDatabase(":memory:"));
  store[method] = () => {
    throw new Error("disk full");
  };
  return store;
}

test.each(["appendLog", "finishJob"] as const)("store.%s throwing still ends the job cleanly", async (method) => {
  const runner = new JobRunner(failingStore(method), () => new Date());
  const job = runner.start(input, async (ctx) => {
    ctx.log("x");
    return "success";
  });
  const collected = collect(runner.events(job.id)!);
  await runner.idle();
  expect(runner.running()).toBeNull();
  const events = await collected;
  expect(events.at(-1)).toEqual({ type: "end", status: method === "appendLog" ? "failed" : "success" });
  expect(() => runner.start(input, async () => "success")).not.toThrow();
  await runner.idle();
});

test("log and setSteps after the job finished are ignored", async () => {
  const { store, runner } = setup();
  let ctx!: Parameters<Parameters<JobRunner["start"]>[1]>[0];
  const job = runner.start(input, async (c) => {
    ctx = c;
    return "success";
  });
  await runner.idle();
  ctx.log("late");
  ctx.setSteps([{ stack: "s", status: "running", from: null, to: null }]);
  expect(store.jobLog(job.id)).toEqual([]);
  expect(store.job(job.id)?.steps).toEqual([]);
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
  // initial steps are replayed once; the unchanged setSteps call emitted nothing extra
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
