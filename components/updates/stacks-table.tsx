"use client";

import { useState } from "react";
import { partition } from "remeda";
import { match } from "ts-pattern";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { stackRow, type StackRow } from "@/lib/updates-view";
import type { StackStatus, UpdateMode } from "@/shared/updater-api";

export type StackActionsProps = {
  disabled: boolean;
  onUpdate: (stack: StackStatus) => void;
  onRollback: (stack: StackStatus) => void;
};

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
  onUpdate,
  onRollback,
}: StackActionsProps & { stack: StackStatus; row: StackRow }) {
  return (
    <div className="flex flex-wrap gap-2">
      {row.kind === "update" && (
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
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onRollback(stack)}>
          Revenir à {stack.rollback.to}
        </Button>
      )}
    </div>
  );
}

export function StacksTable({ stacks, ...actions }: StackActionsProps & { stacks: StackStatus[] }) {
  const [expanded, setExpanded] = useState(false);
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
          return (
            <TableRow key={stack.name} data-testid="stack-row">
              <TableCell className="font-medium">{stack.name}</TableCell>
              <TableCell className="whitespace-normal">
                <StackChange row={row} />
              </TableCell>
              <TableCell>{modeLabel(stack.mode)}</TableCell>
              <TableCell>
                <StackActions stack={stack} row={row} {...actions} />
              </TableCell>
            </TableRow>
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
