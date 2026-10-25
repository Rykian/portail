class StepFailed extends Error {}

/** Aborts the current update or rollback; the message ends up in the job log. */
export function fail(message: string): never {
  throw new StepFailed(message);
}
