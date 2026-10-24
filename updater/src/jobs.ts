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

type Running = { id: number; listeners: Set<(event: JobEvent) => void>; steps: JobStep[] };

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
    const running: Running = { id: job.id, listeners: new Set(), steps: [] };
    this.current = running;
    void this.run(running, work);
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
    return this.follow(id);
  }

  private emit(running: Running, event: JobEvent): void {
    for (const listener of running.listeners) listener(event);
  }

  private async run(running: Running, work: (ctx: JobContext) => Promise<"success" | "failed">): Promise<void> {
    const log: LogSink = (line) => {
      this.store.appendLog(running.id, line);
      this.emit(running, { type: "log", line });
    };
    const setSteps = (steps: JobStep[]) => {
      this.store.setSteps(running.id, steps);
      const previous = running.steps;
      running.steps = steps;
      steps.forEach((step, index) => {
        if (!isDeepEqual(step, previous[index])) this.emit(running, { type: "step", step });
      });
    };
    let status: JobStatus;
    try {
      status = await work({ id: running.id, log, setSteps });
    } catch (error) {
      log(String(error instanceof Error ? error.message : error));
      status = "failed";
    }
    try {
      this.store.finishJob(running.id, status, this.now().toISOString());
    } finally {
      this.current = null;
      this.emit(running, { type: "end", status });
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private async *follow(id: number): AsyncGenerator<JobEvent> {
    // Snapshot and listener registration share one synchronous stretch: nothing is lost or doubled.
    const queue: JobEvent[] = this.store.jobLog(id).map((line) => ({ type: "log", line }));
    const job = this.store.job(id)!;
    queue.push(...job.steps.map((step): JobEvent => ({ type: "step", step })));
    const running = this.current?.id === id ? this.current : null;
    if (!running || job.status !== "running") queue.push({ type: "end", status: job.status });

    let wake: (() => void) | null = null;
    const listener = (event: JobEvent) => {
      queue.push(event);
      wake?.();
    };
    if (running && job.status === "running") running.listeners.add(listener);
    try {
      for (;;) {
        const event = queue.shift();
        if (!event) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          continue;
        }
        yield event;
        if (event.type === "end") return;
      }
    } finally {
      running?.listeners.delete(listener);
    }
  }
}
