"use client";

import { Button } from "@/components/ui/button";
import {
  imageTag,
  lockedServices,
  progressLabel,
  progressPercent,
  selectableServices,
  serviceChange,
  serviceKindLabel,
  stackJobState,
} from "@/lib/updates-view";
import type { StackStatus } from "@portail/shared/updater-api";
import type { StackActionsProps } from "./stacks-table";

/** The expanded lines of a stack: one per service, with its checkbox, change, and progress or rollback. */
export function StackServices({
  stack,
  pendingJobs,
  progress,
  selected,
  disabled,
  onToggle,
  onRollback,
}: StackActionsProps & { stack: StackStatus }) {
  const selectable = selectableServices(stack);
  const locked = lockedServices(stack, pendingJobs);
  const chosen = selected(stack);
  const busy = stackJobState(stack.name, pendingJobs) !== null;

  return (
    <ul aria-label={`Images de ${stack.name}`} className="flex flex-col gap-1 py-1 text-sm">
      {stack.services.map((service) => {
        const change = serviceChange(service);
        const point = stack.serviceRollbacks.find((p) => p.service === service.name);
        const download = progress[`${stack.name}/${service.name}`];
        const checkable = selectable.includes(service.name);
        return (
          <li key={service.name} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex min-w-48 items-center gap-2">
              {checkable ? (
                <input
                  type="checkbox"
                  checked={chosen.includes(service.name)}
                  disabled={locked.has(service.name)}
                  onChange={(event) => onToggle(stack.name, service.name, event.target.checked)}
                />
              ) : (
                <span aria-hidden className="w-3.25" />
              )}
              <span>{service.name}</span>
              <span className="rounded-full border px-1.5 text-xs text-muted-foreground">
                {imageTag(service.image)}
              </span>
            </label>
            <span className="flex-1">
              {change ?? (
                <span className="text-xs text-muted-foreground">
                  {service.kind === "literal" || service.kind === "pinned"
                    ? serviceKindLabel(service.kind)
                    : !service.error && "à jour"}
                </span>
              )}
              {service.error && <span className="block text-destructive">{service.error}</span>}
            </span>
            {download ? (
              <span className="flex items-center gap-2">
                {download.state === "downloading" && (
                  <progress
                    aria-label={`Téléchargement de ${service.name}`}
                    max={100}
                    value={progressPercent(download)}
                    className="h-1.5 w-36 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-blue-500 [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-blue-500"
                  />
                )}
                <span className="text-xs text-muted-foreground">{progressLabel(download)}</span>
              </span>
            ) : (
              point && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => onRollback(stack, point.service)}
                >
                  Revenir à {point.to}
                </Button>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}
