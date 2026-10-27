"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { relativeTime } from "@/lib/relative-time";
import { api } from "@/lib/updates-client";
import {
  lockedServices,
  rollbackWarning,
  selectableServices,
  serviceRollbackWarning,
  updateAllCount,
} from "@/lib/updates-view";
import {
  startResponseSchema,
  stacksResponseSchema,
  updateResponseSchema,
  type StackStatus,
  type StacksResponse,
} from "@portail/shared/updater-api";
import { ConfirmDialog, type Confirmation } from "./confirm-dialog";
import { History } from "./history";
import { JobPanel, useJobEvents } from "./job-panel";
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
  // The job the user last started (or found running), shown in the panel.
  const [job, setJob] = useState<number | null>(null);
  // Per stack, the selectable services the user unchecked; everything else unlocked is selected.
  const [unchecked, setUnchecked] = useState<Record<string, ReadonlySet<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);

  const show = useCallback((response: StacksResponse) => {
    setData(response);
    setLoadedAt(new Date());
    setUnreachable(false);
  }, []);

  // After a job: keep the list on screen if the updater does not answer.
  const reload = useCallback(() => {
    api("stacks", stacksResponseSchema).then(show, () =>
      setError("La liste n'a pas pu être actualisée : le service de mise à jour est injoignable."),
    );
  }, [show]);

  useEffect(() => {
    api("stacks", stacksResponseSchema).then(
      (response) => {
        show(response);
        if (response.runningJob !== null) setJob(response.runningJob);
      },
      () => setUnreachable(true),
    );
  }, [show]);

  // The running job's progress fills the expanded lines; its end brings the next queued job in.
  const running = useJobEvents(data?.runningJob ?? null, reload);
  const progress = running.status === null ? running.progress : {};

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
      started(jobId);
    });

  // A queued job marks its stacks and locks its services: the list must know about it.
  function started(jobId: number) {
    setJob(jobId);
    reload();
  }

  const update = (stack: StackStatus, services?: string[]) =>
    run(async () => {
      const response = await api(`stacks/${encodeURIComponent(stack.name)}/update`, updateResponseSchema, {
        method: "POST",
        body: services ? { services } : {},
      });
      if ("jobId" in response) started(response.jobId);
      else setConfirmation({ kind: "update", stack: stack.name, services, details: response.needsConfirm });
    });

  function rollback(stack: StackStatus, service?: string) {
    const point = stack.serviceRollbacks.find((p) => p.service === service);
    if (point) {
      setConfirmation({
        kind: "rollback",
        stack: stack.name,
        service: point.service,
        to: point.to,
        warning: serviceRollbackWarning(stack, point),
      });
    } else if (stack.rollback) {
      setConfirmation({ kind: "rollback", stack: stack.name, to: stack.rollback.to, warning: rollbackWarning(stack) });
    }
  }

  function confirm(confirmed: Confirmation) {
    setConfirmation(null);
    const path = `stacks/${encodeURIComponent(confirmed.stack)}`;
    if (confirmed.kind === "update") {
      void start(`${path}/update`, { confirm: true, ...(confirmed.services ? { services: confirmed.services } : {}) });
    } else void start(`${path}/rollback`, confirmed.service ? { service: confirmed.service } : {});
  }

  function toggle(stack: string, service: string, checked: boolean) {
    setUnchecked((current) => {
      const next = new Set(current[stack]);
      if (checked) next.delete(service);
      else next.add(service);
      return { ...current, [stack]: next };
    });
  }

  if (unreachable) {
    return (
      <p role="alert" className="text-destructive">
        Le service de mise à jour est injoignable.
      </p>
    );
  }
  if (!data) return <p className="text-muted-foreground">Chargement…</p>;

  const pendingJobs = data.pendingJobs;
  const selected = (stack: StackStatus) => {
    const locked = lockedServices(stack, pendingJobs);
    return selectableServices(stack).filter((s) => !locked.has(s) && !unchecked[stack.name]?.has(s));
  };
  const actions = {
    disabled: pending,
    pendingJobs,
    progress,
    selected,
    onToggle: toggle,
    onUpdate: update,
    onRollback: rollback,
  };

  return (
    <Tabs defaultValue="updates">
      <TabsList>
        <TabsTrigger value="updates">Mises à jour</TabsTrigger>
        <TabsTrigger value="history">Historique</TabsTrigger>
      </TabsList>

      {job !== null && (
        <JobPanel
          key={job}
          jobId={job}
          queued={pendingJobs.some((p) => p.id === job && p.status === "queued")}
          stacks={data.stacks}
          onEnd={reload}
          onRollback={rollback}
          onClose={() => setJob(null)}
        />
      )}

      <TabsContent value="updates" className="pt-4">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {data.lastCheck ? `Vérifié ${relativeTime(new Date(data.lastCheck), loadedAt)}` : "Jamais vérifié"}
          </span>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => start("checks")}>
            Vérifier maintenant
          </Button>
          <Button size="sm" disabled={pending || updateAllCount(data.stacks) === 0} onClick={() => start("updates")}>
            Mettre à jour toutes les stacks
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
