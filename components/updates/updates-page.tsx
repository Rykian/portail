"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relativeTime } from "@/lib/relative-time";
import { api } from "@/lib/updates-client";
import { rollbackWarning, updateAllCount } from "@/lib/updates-view";
import {
  startResponseSchema,
  stacksResponseSchema,
  updateResponseSchema,
  type StackStatus,
  type StacksResponse,
} from "@/shared/updater-api";
import { ConfirmDialog, type Confirmation } from "./confirm-dialog";
import { History } from "./history";
import { JobPanel } from "./job-panel";
import { StacksCards } from "./stacks-cards";
import { StacksTable } from "./stacks-table";

type View = "table" | "cards";
const VIEW_KEY = "updates-view";

function savedView(): View {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function UpdatesPage() {
  const [data, setData] = useState<StacksResponse | null>(null);
  const [loadedAt, setLoadedAt] = useState(() => new Date());
  const [unreachable, setUnreachable] = useState(false);
  const [view, setView] = useState<View>(savedView);
  const [job, setJob] = useState<{ id: number; running: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);

  const show = useCallback((response: StacksResponse) => {
    setData(response);
    setLoadedAt(new Date());
    setUnreachable(false);
  }, []);

  const reload = useCallback(() => {
    api("stacks", stacksResponseSchema).then(show, () => setUnreachable(true));
  }, [show]);

  useEffect(() => {
    api("stacks", stacksResponseSchema).then(
      (response) => {
        show(response);
        if (response.runningJob !== null) setJob({ id: response.runningJob, running: true });
      },
      () => setUnreachable(true),
    );
  }, [show]);

  function chooseView(next: View) {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Storage blocked: the choice lasts until the page is left.
    }
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setPending(false);
    }
  }

  const start = (path: string, body?: unknown) =>
    run(async () => {
      const { jobId } = await api(path, startResponseSchema, { method: "POST", body });
      setJob({ id: jobId, running: true });
    });

  const update = (stack: StackStatus) =>
    run(async () => {
      const response = await api(`stacks/${encodeURIComponent(stack.name)}/update`, updateResponseSchema, {
        method: "POST",
      });
      if ("jobId" in response) setJob({ id: response.jobId, running: true });
      else setConfirmation({ kind: "update", stack: stack.name, details: response.needsConfirm });
    });

  function rollback(stack: StackStatus) {
    if (stack.rollback) {
      setConfirmation({ kind: "rollback", stack: stack.name, to: stack.rollback.to, warning: rollbackWarning(stack) });
    }
  }

  function confirm(confirmed: Confirmation) {
    setConfirmation(null);
    const path = `stacks/${encodeURIComponent(confirmed.stack)}`;
    if (confirmed.kind === "update") void start(`${path}/update`, { confirm: true });
    else void start(`${path}/rollback`);
  }

  if (unreachable) {
    return (
      <p role="alert" className="text-destructive">
        Le service de mise à jour est injoignable.
      </p>
    );
  }
  if (!data) return <p className="text-muted-foreground">Chargement…</p>;

  const busy = pending || (job?.running ?? false);
  const actions = { disabled: busy, onUpdate: update, onRollback: rollback };

  return (
    <Tabs defaultValue="updates">
      <TabsList>
        <TabsTrigger value="updates">Mises à jour</TabsTrigger>
        <TabsTrigger value="history">Historique</TabsTrigger>
      </TabsList>

      {job && (
        <JobPanel
          key={job.id}
          jobId={job.id}
          stacks={data.stacks}
          onEnd={() => {
            setJob((current) => current && { ...current, running: false });
            reload();
          }}
          onRollback={rollback}
          onClose={() => setJob(null)}
        />
      )}

      <TabsContent value="updates" className="pt-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {data.lastCheck ? `Vérifié ${relativeTime(new Date(data.lastCheck), loadedAt)}` : "Jamais vérifié"}
          </span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => start("checks")}>
            Vérifier maintenant
          </Button>
          <Button size="sm" disabled={busy || updateAllCount(data.stacks) === 0} onClick={() => start("updates")}>
            Tout mettre à jour
          </Button>
          <fieldset className="ml-auto flex gap-1">
            <legend className="sr-only">Présentation</legend>
            <Button
              variant={view === "table" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={view === "table"}
              onClick={() => chooseView("table")}
            >
              Tableau
            </Button>
            <Button
              variant={view === "cards" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={view === "cards"}
              onClick={() => chooseView("cards")}
            >
              Cartes
            </Button>
          </fieldset>
        </div>

        {data.configError && (
          <p role="alert" className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            {data.configError}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}

        {view === "table" ? (
          <StacksTable stacks={data.stacks} {...actions} />
        ) : (
          <StacksCards stacks={data.stacks} {...actions} />
        )}
      </TabsContent>

      <TabsContent value="history" className="pt-4">
        <History />
      </TabsContent>

      <ConfirmDialog confirmation={confirmation} onConfirm={confirm} onCancel={() => setConfirmation(null)} />
    </Tabs>
  );
}
