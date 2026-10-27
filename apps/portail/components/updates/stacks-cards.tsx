"use client";

import { useState } from "react";
import { stackRow } from "@/lib/updates-view";
import type { StackStatus } from "@portail/shared/updater-api";
import { StackServices } from "./stack-services";
import {
  ExpandButton,
  modeLabel,
  StackActions,
  StackChange,
  StackJobBadge,
  type StackActionsProps,
} from "./stacks-table";

export function StacksCards({ stacks, ...actions }: StackActionsProps & { stacks: StackStatus[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (name: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {stacks.map((stack) => {
        const row = stackRow(stack);
        return (
          <li
            key={stack.name}
            data-testid="stack-card"
            className={`flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm ${row.kind === "up-to-date" ? "opacity-50" : ""}`}
          >
            <span className="flex items-baseline gap-2">
              <ExpandButton stack={stack} expanded={open.has(stack.name)} onToggle={() => toggle(stack.name)} />
              <span className="font-medium">{stack.name}</span>
              <span className="text-xs text-muted-foreground">{modeLabel(stack.mode)}</span>
              <StackJobBadge stack={stack} pendingJobs={actions.pendingJobs} />
            </span>
            <span>
              <StackChange row={row} />
            </span>
            {open.has(stack.name) && <StackServices stack={stack} {...actions} />}
            <StackActions stack={stack} row={row} {...actions} />
          </li>
        );
      })}
    </ul>
  );
}
