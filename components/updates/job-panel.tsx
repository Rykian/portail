"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { jobEventSchema, type JobStatus, type JobStep, type StackStatus } from "@/shared/updater-api";

export type JobLog = { lines: string[]; steps: JobStep[]; status: JobStatus | null; lost: boolean };

export function statusLabel(status: JobStatus): string {
  return match(status)
    .with("running", () => "en cours")
    .with("success", () => "réussie")
    .with("failed", () => "échouée")
    .with("interrupted", () => "interrompue")
    .exhaustive();
}

function stepLabel(status: Exclude<JobStep["status"], "not-started">): string {
  return match(status)
    .with("pending", () => "en attente")
    .with("running", () => "en cours")
    .with("success", () => "réussie")
    .with("failed", () => "échouée")
    .exhaustive();
}

/** Follows a job's SSE stream. The server replays from the start on every connection, then ends with `end`. */
export function useJobEvents(jobId: number, onEnd?: (status: JobStatus) => void): JobLog {
  const [log, setLog] = useState<JobLog>({ lines: [], steps: [], status: null, lost: false });
  const ended = useEffectEvent((status: JobStatus) => onEnd?.(status));

  useEffect(() => {
    const source = new EventSource(`/api/updates/jobs/${jobId}/events`);
    // EventSource reconnects by itself (e.g. while the portal restarts); each connection replays the whole job.
    source.onopen = () => setLog({ lines: [], steps: [], status: null, lost: false });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setLog((current) => ({ ...current, lost: true }));
    };
    source.onmessage = (message) => {
      const parsed = jobEventSchema.safeParse(JSON.parse(message.data));
      if (!parsed.success) return;
      match(parsed.data)
        .with({ type: "log" }, ({ line }) => setLog((current) => ({ ...current, lines: [...current.lines, line] })))
        .with({ type: "step" }, ({ step }) =>
          setLog((current) => ({
            ...current,
            steps: current.steps.some((s) => s.stack === step.stack)
              ? current.steps.map((s) => (s.stack === step.stack ? step : s))
              : [...current.steps, step],
          })),
        )
        .with({ type: "end" }, ({ status }) => {
          // Without close(), EventSource would reconnect and replay the job forever.
          source.close();
          setLog((current) => ({ ...current, status }));
          ended(status);
        })
        .exhaustive();
    };
    return () => source.close();
  }, [jobId]);

  return log;
}

export function JobLines({ log }: { log: JobLog }) {
  return (
    <pre
      role="log"
      aria-live="polite"
      aria-label="Journal"
      className="max-h-80 overflow-auto rounded-md bg-neutral-950 p-3 text-xs whitespace-pre-wrap text-neutral-100"
    >
      {log.lines.join("\n")}
    </pre>
  );
}

export function JobPanel({
  jobId,
  stacks,
  onEnd,
  onRollback,
  onClose,
}: {
  jobId: number;
  stacks: StackStatus[];
  onEnd: () => void;
  onRollback: (stack: StackStatus) => void;
  onClose: () => void;
}) {
  const log = useJobEvents(jobId, onEnd);
  const notStarted = log.steps.filter((s) => s.status === "not-started");
  const failed = log.steps.find((s) => s.status === "failed");
  const rollback = log.status === "failed" && failed ? stacks.find((s) => s.name === failed.stack && s.rollback) : null;

  return (
    <section aria-label={`Tâche ${jobId}`} className="mb-6 rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-medium">Tâche n° {jobId}</h2>
        <span data-testid="job-status" className="text-sm text-muted-foreground">
          {log.status ? statusLabel(log.status) : "en cours"}
        </span>
        {(log.status || log.lost) && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClose}>
            Fermer
          </Button>
        )}
      </div>
      {log.steps.length > 0 && (
        <ul className="mb-3 text-sm">
          {log.steps
            .filter((s) => s.status !== "not-started")
            .map((step) => (
              <li key={step.stack}>
                <span className="font-medium">{step.stack}</span>
                {step.from && step.to && ` ${step.from} → ${step.to}`} :{" "}
                {step.status !== "not-started" && stepLabel(step.status)}
              </li>
            ))}
          {notStarted.length > 0 && <li>non lancées : {notStarted.map((s) => s.stack).join(", ")}</li>}
        </ul>
      )}
      <JobLines log={log} />
      {log.lost && <p className="mt-2 text-sm text-destructive">Journal indisponible.</p>}
      {rollback?.rollback && (
        <Button className="mt-3" variant="destructive" onClick={() => onRollback(rollback)}>
          Revenir à {rollback.rollback.to}
        </Button>
      )}
    </section>
  );
}
