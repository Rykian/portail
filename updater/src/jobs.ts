import { isDeepEqual } from "remeda";
import type { Job, JobEvent, JobKind, JobStatus, JobStep } from "@shared/updater-api";
import type { LogSink } from "./docker";
import type { Store } from "./store";

export class BusyError extends Error {
  constructor() {
    super("Une tâche est déjà en cours");
    this.name = "BusyError";
  }
}

export type JobContext = { id: number; log: LogSink; setSteps(steps: JobStep[]): void };

type Running = { id: number; listeners: Set<(event: JobEvent) => void>; steps: JobStep[]; finished: boolean };

export class JobRunner {
  private current: Running | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly now: () => Date,
  ) {}

  start(
    input: { kind: JobKind; user: string | null; steps: JobStep[] },
    work: (ctx: JobContext) => Promise<"success" | "failed">,
  ): Job {
    if (this.current) throw new BusyError();
    const job = this.store.createJob({ ...input, startedAt: this.now().toISOString() });
    const running: Running = {
      id: job.id,
      listeners: new Set(),
      steps: input.steps.map((step) => ({ ...step })),
      finished: false,
    };
    this.current = running;
    this.run(running, work).catch((error) => console.error("job runner failed", error));
    return job;
  }

  running(): number | null {
    return this.current?.id ?? null;
  }

  idle(): Promise<void> {
    if (!this.current) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  events(id: number): AsyncIterable<JobEvent> | null {
    if (!this.store.job(id)) return null;
    return { [Symbol.asyncIterator]: () => this.follow(id) };
  }

  /** Test-only: number of live subscribers of the running job. */
  listenerCount(id: number): number {
    return this.current?.id === id ? this.current.listeners.size : 0;
  }

  private emit(running: Running, event: JobEvent): void {
    for (const listener of running.listeners) listener(event);
  }

  private async run(running: Running, work: (ctx: JobContext) => Promise<"success" | "failed">): Promise<void> {
    const log: LogSink = (line) => {
      if (running.finished) return;
      this.store.appendLog(running.id, line);
      this.emit(running, { type: "log", line });
    };
    const setSteps = (steps: JobStep[]) => {
      if (running.finished) return;
      const next = steps.map((step) => ({ ...step }));
      this.store.setSteps(running.id, next);
      const previous = running.steps;
      running.steps = next;
      next.forEach((step, index) => {
        if (!isDeepEqual(step, previous[index])) this.emit(running, { type: "step", step });
      });
    };
    let status: JobStatus = "failed";
    try {
      status = await work({ id: running.id, log, setSteps });
    } catch (error) {
      try {
        log(String(error instanceof Error ? error.message : error));
      } catch (logError) {
        console.error("job log failed", logError);
      }
    }
    try {
      this.store.finishJob(running.id, status, this.now().toISOString());
    } finally {
      running.finished = true;
      this.current = null;
      this.emit(running, { type: "end", status });
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private follow(id: number): AsyncIterator<JobEvent> {
    // Snapshot and listener registration share one synchronous stretch: nothing is lost or doubled.
    const queue: JobEvent[] = this.store.jobLog(id).map((line) => ({ type: "log", line }));
    const job = this.store.job(id)!;
    queue.push(...job.steps.map((step): JobEvent => ({ type: "step", step })));
    const running = this.current?.id === id && job.status === "running" ? this.current : null;
    if (!running) queue.push({ type: "end", status: job.status });

    let done = false;
    let waiter: ((result: IteratorResult<JobEvent>) => void) | null = null;
    const finish = () => {
      done = true;
      running?.listeners.delete(listener);
    };
    const pump = () => {
      if (!waiter) return;
      if (done) {
        waiter({ value: undefined, done: true });
        waiter = null;
      } else if (queue.length > 0) {
        const event = queue.shift()!;
        if (event.type === "end") finish();
        waiter({ value: event, done: false });
        waiter = null;
      }
    };
    const listener = (event: JobEvent) => {
      queue.push(event);
      pump();
    };
    running?.listeners.add(listener);
    return {
      next: () =>
        new Promise((resolve) => {
          waiter = resolve;
          pump();
        }),
      return: () => {
        finish();
        pump();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
