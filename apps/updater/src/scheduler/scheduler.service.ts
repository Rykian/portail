import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { CLOCK } from "../common/runtime";
import { DetectionService } from "../detection/detection.service";
import { JobRunner } from "../jobs/job-runner";
import { JobStore } from "../jobs/job.store";

const HOUR = 3_600_000;
const CHECK_EVERY = 6 * HOUR;
const PURGE_EVERY = 24 * HOUR;
const KEEP_LOGS = 90 * 24 * HOUR;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    @Inject(DetectionService) private readonly detection: DetectionService,
    @Inject(JobRunner) private readonly jobs: JobRunner,
    @Inject(JobStore) private readonly jobStore: JobStore,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Checks every 6 h (and at start-up when the last check is older, else prunes points), purges old logs daily. */
  start(): void {
    const check = () => {
      if (this.jobs.busy()) return;
      try {
        this.detection.check(null);
      } catch (error) {
        console.error("scheduled check failed", error);
      }
    };
    const purge = () => {
      try {
        this.jobStore.purgeLogs(new Date(this.now().getTime() - KEEP_LOGS).toISOString());
      } catch (error) {
        console.error("log purge failed", error);
      }
    };

    const lastCheck = this.detection.lastCheck();
    // A check prunes rollback points itself; without one, points migrated at start-up are pruned now.
    if (lastCheck === null || this.now().getTime() - Date.parse(lastCheck) >= CHECK_EVERY) check();
    else void this.detection.pruneAllPoints();
    purge();

    this.timers = [setInterval(check, CHECK_EVERY), setInterval(purge, PURGE_EVERY)];
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
  }
}
