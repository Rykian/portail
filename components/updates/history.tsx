"use client";

import { useEffect, useState } from "react";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/updates-client";
import { historyPageSchema, type Job, type JobKind } from "@/shared/updater-api";
import { JobLines, statusLabel, useJobEvents } from "./job-panel";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });

function kindLabel(kind: JobKind): string {
  return match(kind)
    .with("check", () => "vérification")
    .with("update", () => "mise à jour")
    .with("rollback", () => "retour arrière")
    .with("update-all", () => "tout mettre à jour")
    .exhaustive();
}

function versions(job: Job): string {
  return job.steps
    .filter((step) => step.from || step.to)
    .map((step) => `${step.from ?? "?"} → ${step.to ?? "?"}`)
    .join(", ");
}

function JobLogDialog({ job, onClose }: { job: Job; onClose: () => void }) {
  const log = useJobEvents(job.id);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>
          Journal : {kindLabel(job.kind)} du {dateFormat.format(new Date(job.startedAt))}
        </DialogTitle>
        <JobLines log={log} />
      </DialogContent>
    </Dialog>
  );
}

export function History() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Job | null>(null);

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));

  useEffect(() => {
    api("history", historyPageSchema).then((page) => {
      setJobs(page.jobs);
      setNext(page.nextCursor);
    }, fail);
  }, []);

  function more(cursor: number) {
    api(`history?cursor=${cursor}`, historyPageSchema).then((page) => {
      setJobs((current) => [...(current ?? []), ...page.jobs]);
      setNext(page.nextCursor);
    }, fail);
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 text-destructive">
          {error}
        </p>
      )}
      {jobs === null ? (
        !error && <p className="text-muted-foreground">Chargement…</p>
      ) : jobs.length === 0 ? (
        <p className="text-muted-foreground">Aucune tâche pour l’instant.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Utilisateur</TableHead>
              <TableHead>Stack</TableHead>
              <TableHead>Versions</TableHead>
              <TableHead>Résultat</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id} data-testid="history-row" className="cursor-pointer" onClick={() => setOpen(job)}>
                <TableCell>
                  <button type="button" className="underline-offset-4 hover:underline" onClick={() => setOpen(job)}>
                    {dateFormat.format(new Date(job.startedAt))}
                  </button>
                </TableCell>
                <TableCell>{job.user ?? "planifiée"}</TableCell>
                <TableCell className="whitespace-normal">
                  {job.steps.length > 0 ? job.steps.map((step) => step.stack).join(", ") : kindLabel(job.kind)}
                </TableCell>
                <TableCell className="whitespace-normal">{versions(job)}</TableCell>
                <TableCell>{statusLabel(job.status)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {next !== null && (
        <Button variant="outline" className="mt-3" onClick={() => more(next)}>
          Plus
        </Button>
      )}
      {open && <JobLogDialog job={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
