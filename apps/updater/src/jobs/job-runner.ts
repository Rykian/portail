import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { isDeepEqual } from "remeda";
import type {
  ImageProgress,
  Job,
  JobEvent,
  JobKind,
  JobStatus,
  JobStep,
  JobTarget,
  PendingJob,
} from "@portail/shared/updater-api";
import { CLOCK } from "../common/runtime";
import type { LogSink } from "../docker/docker";
import { JobStore } from "./job.store";

/** Minimum delay between two progress events of one image; a state change always goes out. */
const PROGRESS_INTERVAL = 250;

export type JobContext = {
  id: number;
  log: LogSink;
  setSteps(steps: JobStep[]): void;
  progress(p: ImageProgress): void;
};

type Work = (ctx: JobContext) => Promise<"success" | "failed">;

type Running = {
  id: number;
  kind: JobKind;
  targets: JobTarget[];
  listeners: Set<(event: JobEvent) => void>;
  steps: JobStep[];
  /** Latest progress per `stack/service`, replayed to late followers; cleared when the job ends. */
  progress: Map<string, ImageProgress>;
  /** When the last progress event of each `stack/service` went out. */
  progressSentAt: Map<string, number>;
  finished: boolean;
};

/** Runs one job at a time and queues the others, records their log and steps, streams them to followers. */
@Injectable()
export class JobRunner implements OnModuleInit {
  private current: Running | null = null;
  private queue: { running: Running; work: Work }[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(
    @Inject(JobStore) private readonly store: JobStore,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  /** Runs before any `onApplicationBootstrap`, so the scheduler's first check is never marked interrupted. */
  onModuleInit(): void {
    const interrupted = this.store.markInterrupted(this.now().toISOString());
    if (interrupted > 0) console.warn(`${interrupted} tâche(s) marquée(s) interrompue(s)`);
  }

  /** Runs the job now when nothing runs, otherwise queues it behind the others. */
  start(input: { kind: JobKind; user: string | null; steps: JobStep[]; targets: JobTarget[] }, work: Work): Job {
    const queued = this.busy();
    const job = this.store.createJob({
      kind: input.kind,
      user: input.user,
      steps: input.steps,
      startedAt: this.now().toISOString(),
      status: queued ? "queued" : "running",
    });
    const running: Running = {
      id: job.id,
      kind: input.kind,
      targets: input.targets,
      listeners: new Set(),
      steps: input.steps.map((step) => ({ ...step })),
      progress: new Map(),
      progressSentAt: new Map(),
      finished: false,
    };
    if (queued) this.queue.push({ running, work });
    else this.launch(running, work, false);
    return job;
  }

  running(): number | null {
    return this.current?.id ?? null;
  }

  /** The running job first, then the queue in order. */
  pending(): PendingJob[] {
    const live = this.current ? [this.current, ...this.queue.map((q) => q.running)] : [];
    return live.map((running) => ({
      id: running.id,
      kind: running.kind,
      status: running === this.current ? "running" : "queued",
      targets: running.targets,
    }));
  }

  /** A job runs or is queued. */
  busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** Resolves once nothing runs and the queue is empty. */
  idle(): Promise<void> {
    if (!this.busy()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  events(id: number): AsyncIterable<JobEvent> | null {
    if (!this.store.job(id)) return null;
    return { [Symbol.asyncIterator]: () => this.follow(id) };
  }

  /** Test-only: number of live subscribers of a running or queued job. */
  listenerCount(id: number): number {
    return this.live(id)?.listeners.size ?? 0;
  }

  /** The running or queued job with this id. */
  private live(id: number): Running | null {
    if (this.current?.id === id) return this.current;
    return this.queue.find((q) => q.running.id === id)?.running ?? null;
  }

  private launch(running: Running, work: Work, wasQueued: boolean): void {
    this.current = running;
    this.run(running, work, wasQueued).catch((error) => console.error("job runner failed", error));
  }

  private emit(running: Running, event: JobEvent): void {
    for (const listener of running.listeners) listener(event);
  }

  private async run(running: Running, work: Work, wasQueued: boolean): Promise<void> {
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
    // Never stored: kept in memory for the replay, sent at most every PROGRESS_INTERVAL per image.
    const progress = (p: ImageProgress) => {
      if (running.finished) return;
      const key = `${p.stack}/${p.service}`;
      const previous = running.progress.get(key);
      running.progress.set(key, { ...p });
      const at = this.now().getTime();
      const sentAt = running.progressSentAt.get(key);
      if (previous?.state === p.state && sentAt !== undefined && at - sentAt < PROGRESS_INTERVAL) return;
      running.progressSentAt.set(key, at);
      this.emit(running, { type: "progress", progress: { ...p } });
    };
    let status: JobStatus = "failed";
    try {
      if (wasQueued) this.store.markStarted(running.id, this.now().toISOString());
      status = await work({ id: running.id, log, setSteps, progress });
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
      running.progress.clear();
      running.progressSentAt.clear();
      this.current = null;
      this.emit(running, { type: "end", status });
      this.next();
    }
  }

  /** Starts the next queued job, or wakes `idle()` waiters when the queue is empty. */
  private next(): void {
    const next = this.queue.shift();
    if (next) this.launch(next.running, next.work, true);
    else for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private follow(id: number): AsyncIterator<JobEvent> {
    // Snapshot and listener registration share one synchronous stretch: nothing is lost or doubled.
    const queue: JobEvent[] = this.store.jobLog(id).map((line) => ({ type: "log", line }));
    const job = this.store.job(id)!;
    queue.push(...job.steps.map((step): JobEvent => ({ type: "step", step })));
    // A queued job is followed like a running one: its stream waits for it to run.
    const running = this.live(id);
    if (running)
      queue.push(...[...running.progress.values()].map((p): JobEvent => ({ type: "progress", progress: p })));
    else queue.push({ type: "end", status: job.status });

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
