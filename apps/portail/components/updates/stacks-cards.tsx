"use client";

import { stackRow } from "@/lib/updates-view";
import type { StackStatus } from "@portail/shared/updater-api";
import { modeLabel, StackActions, StackChange, type StackActionsProps } from "./stacks-table";

export function StacksCards({ stacks, ...actions }: StackActionsProps & { stacks: StackStatus[] }) {
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
              <span className="font-medium">{stack.name}</span>
              <span className="text-xs text-muted-foreground">{modeLabel(stack.mode)}</span>
            </span>
            <span>
              <StackChange row={row} />
            </span>
            <StackActions stack={stack} row={row} {...actions} />
          </li>
        );
      })}
    </ul>
  );
}
