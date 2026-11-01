"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/updates-client";
import { jobFinished, jobPanelLabel, mergeProgress, panelRollback, stepTitle } from "@/lib/updates-view";
import {
  jobEventSchema,
  jobSchema,
  type ImageProgress,
  type JobStatus,
  type JobStep,
  type PendingJob,
  type StackStatus,
} from "@portail/shared/updater-api";

export type JobLog = {
  lines: string[];
  steps: JobStep[];
  /** Latest download progress, keyed `<stack>/<service>`. */
  progress: Record<string, ImageProgress>;
  status: JobStatus | null;
  lost: boolean;
};

function stepLabel(status: Exclude<JobStep["status"], "not-started">): string {
  return match(status)
    .with("pending", () => "en attente")
    .with("running", () => "en cours")
    .with("success", () => "réussie")
    .with("failed", () => "échouée")
    .exhaustive();
}

const EMPTY_LOG: JobLog = { lines: [], steps: [], progress: {}, status: null, lost: false };
const POLL_MS = 3000;

/**
 * Follows a job's SSE stream. The server replays from the start on every connection, then ends with `end`.
 * EventSource reconnects by itself while the connection drops (portal restart), but gives up for good when the
 * server answers a non-200 (portal or proxy still starting): then the job is polled until the stream can be reopened.
 */
export function useJobEvents(jobId: number | null, onEnd?: (status: JobStatus) => void): JobLog {
  const [log, setLog] = useState<JobLog>(EMPTY_LOG);
  const ended = useEffectEvent((status: JobStatus) => onEnd?.(status));

  useEffect(() => {
    if (jobId === null) return;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // Set when a poll finds the job finished: the next reopening replays the whole log and is the last attempt.
    let lastAttempt = false;

    function lose() {
      setLog((current) => ({ ...current, lost: true }));
    }

    function poll() {
      api(`jobs/${jobId}`, jobSchema).then(
        (job) => {
          if (jobFinished(job.status)) lastAttempt = true;
          if (!cancelled) connect();
        },
        // Unknown for now (updater restarting, 502, 404): try the stream again.
        () => !cancelled && connect(),
      );
    }

    function connect() {
      source?.close();
      const current = new EventSource(`/api/updates/jobs/${jobId}/events`);
      source = current;
      current.onopen = () => {
        clearTimeout(timer);
        // A drop during this replay must start polling again, not give up.
        lastAttempt = false;
        setLog(EMPTY_LOG);
      };
      current.onerror = () => {
        if (current.readyState !== EventSource.CLOSED) return;
        lose();
        if (!lastAttempt) timer = setTimeout(poll, POLL_MS);
      };
      current.onmessage = (message) => {
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          // Reconnecting would replay the same event: stop following instead.
          current.close();
          lose();
          return;
        }
        const parsed = jobEventSchema.safeParse(data);
        if (!parsed.success) return;
        match(parsed.data)
          .with({ type: "log" }, ({ line }) => setLog((state) => ({ ...state, lines: [...state.lines, line] })))
          .with({ type: "step" }, ({ step }) =>
            setLog((state) => ({
              ...state,
              steps: state.steps.some((s) => s.stack === step.stack)
                ? state.steps.map((s) => (s.stack === step.stack ? step : s))
                : [...state.steps, step],
            })),
          )
          .with({ type: "progress" }, ({ progress }) => {
            const key = `${progress.stack}/${progress.service}`;
            setLog((state) => ({
              ...state,
              progress: { ...state.progress, [key]: mergeProgress(state.progress[key], progress) },
            }));
          })
          .with({ type: "end" }, ({ status }) => {
            // Without close(), EventSource would reconnect and replay the job forever.
            current.close();
            setLog((state) => ({ ...state, status }));
            ended(status);
          })
          .exhaustive();
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [jobId]);

  return log;
}

export function JobLines({ log }: { log: JobLog }) {
  const ref = useRef<HTMLPreElement>(null);
  // Follows new lines until the user scrolls up, and again once they scroll back to the bottom.
  const following = useRef(true);

  useLayoutEffect(() => {
    const pre = ref.current;
    if (pre && following.current) pre.scrollTop = pre.scrollHeight;
  }, [log.lines]);

  return (
    <>
      <pre
        ref={ref}
        onScroll={(event) => {
          const pre = event.currentTarget;
          following.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        }}
        role="log"
        aria-live="polite"
        aria-label="Journal"
        className="max-h-80 overflow-auto rounded-md bg-neutral-950 p-3 text-xs whitespace-pre-wrap text-neutral-100"
      >
        {log.lines.join("\n")}
      </pre>
      {log.lost && <p className="mt-2 text-sm text-destructive">Journal indisponible.</p>}
    </>
  );
}

export function JobPanel({
  jobId,
  queued,
  stacks,
  pendingJobs,
  onEnd,
  onRollback,
  onClose,
}: {
  jobId: number;
  /** The stacks list last reported this job as queued. */
  queued: boolean;
  stacks: StackStatus[];
  pendingJobs: PendingJob[];
  onEnd: () => void;
  /** `service` absent: the stack-level rollback. */
  onRollback: (stack: StackStatus, service?: string) => void;
  onClose: () => void;
}) {
  const log = useJobEvents(jobId, onEnd);
  const notStarted = log.steps.filter((s) => s.status === "not-started");
  const failed = log.steps.find((s) => s.status === "failed");
  const rollback = log.status === "failed" ? panelRollback(failed, stacks, pendingJobs) : null;

  return (
    <section aria-label={`Tâche ${jobId}`} className="mb-6 rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-medium">Tâche n° {jobId}</h2>
        <span data-testid="job-status" className="text-sm text-muted-foreground">
          {jobPanelLabel(log, queued)}
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
                <span className="font-medium">{stepTitle(step)}</span>
                {step.from && step.to && ` ${step.from} → ${step.to}`} :{" "}
                {step.status !== "not-started" && stepLabel(step.status)}
              </li>
            ))}
          {notStarted.length > 0 && <li>non lancées : {notStarted.map((s) => s.stack).join(", ")}</li>}
        </ul>
      )}
      <JobLines log={log} />
      {rollback && (
        <div className="mt-3 flex flex-wrap gap-2">
          {rollback.points === null ? (
            <Button variant="destructive" disabled={rollback.disabled} onClick={() => onRollback(rollback.stack)}>
              {rollback.stack.serviceRollbacks.length > 0
                ? "Tout remettre en arrière"
                : `Revenir à ${rollback.stack.rollback?.to}`}
            </Button>
          ) : (
            rollback.points.map((point) => (
              <Button
                key={point.service}
                variant="destructive"
                disabled={rollback.disabled}
                onClick={() => onRollback(rollback.stack, point.service)}
              >
                Revenir à {point.to} ({point.service})
              </Button>
            ))
          )}
        </div>
      )}
    </section>
  );
}
