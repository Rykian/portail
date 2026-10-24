import type { JobRunner } from "./jobs";
import type { UpdaterService } from "./service";
import type { Store } from "./store";

const HOUR = 3_600_000;
const CHECK_EVERY = 6 * HOUR;
const PURGE_EVERY = 24 * HOUR;
const KEEP_LOGS = 90 * 24 * HOUR;

/** Checks every 6 h (and at start-up when the last check is older), purges old logs daily. Returns stop. */
export function startScheduler(service: UpdaterService, jobs: JobRunner, store: Store, now: () => Date): () => void {
  const check = () => {
    if (jobs.running() !== null) return;
    try {
      service.check(null);
    } catch (error) {
      console.error("scheduled check failed", error);
    }
  };
  const purge = () => {
    try {
      store.purgeLogs(new Date(now().getTime() - KEEP_LOGS).toISOString());
    } catch (error) {
      console.error("log purge failed", error);
    }
  };

  const lastCheck = store.getMeta("lastCheck");
  if (lastCheck === null || now().getTime() - Date.parse(lastCheck) >= CHECK_EVERY) check();
  purge();

  const timers = [setInterval(check, CHECK_EVERY), setInterval(purge, PURGE_EVERY)];
  for (const timer of timers) timer.unref?.();
  return () => {
    for (const timer of timers) clearInterval(timer);
  };
}
