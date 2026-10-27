"use client";

import { Fragment, useState } from "react";
import { partition } from "remeda";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lockedServices, selectableServices, stackJobState, stackRow, type StackRow } from "@/lib/updates-view";
import type { ImageProgress, PendingJob, StackStatus, UpdateMode } from "@portail/shared/updater-api";
import { StackServices } from "./stack-services";

export type StackActionsProps = {
  /** A request is in flight. */
  disabled: boolean;
  pendingJobs: PendingJob[];
  /** Download progress of the running job, keyed `<stack>/<service>`. */
  progress: Record<string, ImageProgress>;
  /** The checked services of a stack. */
  selected: (stack: StackStatus) => string[];
  onToggle: (stack: string, service: string, checked: boolean) => void;
  /** `services` absent: the whole stack. */
  onUpdate: (stack: StackStatus, services?: string[]) => void;
  /** `service` absent: every rollback point of the stack. */
  onRollback: (stack: StackStatus, service?: string) => void;
};

/** « en attente » / « en cours » next to a stack's name. */
export function StackJobBadge({ stack, pendingJobs }: { stack: StackStatus; pendingJobs: PendingJob[] }) {
  const state = stackJobState(stack.name, pendingJobs);
  if (!state) return null;
  return <span className="text-xs text-muted-foreground">{state === "running" ? "en cours" : "en attente"}</span>;
}

export function ExpandButton({
  stack,
  expanded,
  onToggle,
}: {
  stack: StackStatus;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`Détails de ${stack.name}`}
      onClick={onToggle}
      className="w-4 text-muted-foreground"
    >
      {expanded ? "▾" : "▸"}
    </button>
  );
}

export function modeLabel(mode: UpdateMode): string {
  return match(mode)
    .with("pull", () => "pull")
    .with("version", () => "variable")
    .with("recipe", () => "recette")
    .exhaustive();
}

export function StackChange({ row }: { row: StackRow }) {
  return match(row)
    .with({ kind: "update" }, ({ label, detail }) => (
      <>
        <span className="block">{label}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </>
    ))
    .with({ kind: "literal" }, ({ label }) => (
      <>
        <span className="block">{label}</span>
        <span className="block text-xs text-muted-foreground">Passer la version dans une variable pour l'activer</span>
      </>
    ))
    .with({ kind: "error" }, ({ message }) => <span className="text-destructive">{message}</span>)
    .with({ kind: "up-to-date" }, { kind: "rollback-only" }, () => (
      <span className="text-muted-foreground">à jour</span>
    ))
    .exhaustive();
}

export function StackActions({
  stack,
  row,
  disabled,
  pendingJobs,
  selected,
  onUpdate,
  onRollback,
}: StackActionsProps & { stack: StackStatus; row: StackRow }) {
  const busy = stackJobState(stack.name, pendingJobs) !== null;
  const locked = lockedServices(stack, pendingJobs);
  const all = selectableServices(stack).filter((s) => !locked.has(s));
  const chosen = selected(stack);

  return (
    <div className="flex flex-wrap gap-2">
      {row.kind === "update" && stack.selectable && (
        <>
          <Button
            size="sm"
            disabled={disabled || all.length === 0}
            aria-label={`Tout mettre à jour ${stack.name}`}
            onClick={() => onUpdate(stack, all)}
          >
            Tout mettre à jour
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || chosen.length === 0}
            onClick={() => onUpdate(stack, chosen)}
          >
            Mettre à jour la sélection ({chosen.length})
          </Button>
        </>
      )}
      {row.kind === "update" && !stack.selectable && (
        <Button
          size="sm"
          disabled={disabled}
          aria-label={`Mettre à jour ${stack.name}`}
          onClick={() => onUpdate(stack)}
        >
          {stack.needsConfirm ? "Mettre à jour…" : "Mettre à jour"}
        </Button>
      )}
      {stack.rollback && (
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => onRollback(stack)}>
          {stack.serviceRollbacks.length > 0 ? "Tout remettre en arrière" : `Revenir à ${stack.rollback.to}`}
        </Button>
      )}
    </div>
  );
}

export function StacksTable({ stacks, ...actions }: StackActionsProps & { stacks: StackStatus[] }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (name: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const [upToDate, others] = partition(stacks, (stack) => stackRow(stack).kind === "up-to-date");

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Stack</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>
            <span className="sr-only">Action</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {others.map((stack) => {
          const row = stackRow(stack);
          const isOpen = open.has(stack.name);
          return (
            <Fragment key={stack.name}>
              <TableRow data-testid="stack-row">
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    <ExpandButton stack={stack} expanded={isOpen} onToggle={() => toggle(stack.name)} />
                    {stack.name}
                    <StackJobBadge stack={stack} pendingJobs={actions.pendingJobs} />
                  </span>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <StackChange row={row} />
                </TableCell>
                <TableCell>{modeLabel(stack.mode)}</TableCell>
                <TableCell>
                  <StackActions stack={stack} row={row} {...actions} />
                </TableCell>
              </TableRow>
              {isOpen && (
                <TableRow>
                  <TableCell colSpan={4} className="pl-10 whitespace-normal">
                    <StackServices stack={stack} {...actions} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          );
        })}
        {upToDate.length > 0 && (
          <TableRow className="text-muted-foreground">
            <TableCell colSpan={4} className="whitespace-normal">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
                className="underline-offset-4 hover:underline"
              >
                {upToDate.length} à jour
              </button>
              {expanded && <span className="ml-2">{upToDate.map((stack) => stack.name).join(", ")}</span>}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
