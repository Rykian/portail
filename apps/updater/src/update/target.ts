import type { StackStatus } from "@portail/shared/updater-api";
import { compareVersions } from "../docker/versions";

/** What an update request was validated against when it was queued: the job applies this target or nothing. */
export type PinnedTarget = {
  stack: string;
  /** The stack-level target (the version variable of version/recipe stacks). */
  available: string | null;
  /** The selected services of a pull-style update and their targets; empty for a stack-level update. */
  services: { name: string; available: string | null; newImageDate: string | null }[];
  /** The user confirmed this target (or did not need to when it was queued, for update-all). */
  confirmed: boolean;
};

export function pinTarget(status: StackStatus, selection: string[] | null, confirmed: boolean): PinnedTarget {
  return {
    stack: status.name,
    available: status.available,
    services: status.services
      .filter((s) => selection?.includes(s.name) ?? false)
      .map((s) => ({ name: s.name, available: s.available, newImageDate: s.newImageDate })),
    confirmed,
  };
}

const changed = (from: string | null, to: string | null): string =>
  `la cible a changé depuis la demande (${from ?? "aucune"} → ${to ?? "aucune"}) : relancer la mise à jour`;

/** Why the pinned target no longer matches the fresh status (the user must start again), or null when it still does. */
export function staleReason(pinned: PinnedTarget, fresh: StackStatus, freshNeedsConfirm: boolean): string | null {
  // Pull stacks have no stack-level target: their stack `available` only mirrors one of their services.
  if (fresh.mode !== "pull" && fresh.available !== pinned.available) return changed(pinned.available, fresh.available);
  for (const service of pinned.services) {
    const now = fresh.services.find((s) => s.name === service.name);
    // A service already brought up to date (or gone) is simply left out of the run.
    if (!now?.update) continue;
    const before = service.available ?? service.newImageDate;
    const after = now.available ?? now.newImageDate;
    if (before !== after) return changed(before, after);
  }
  if (freshNeedsConfirm && !pinned.confirmed) {
    return "une confirmation est maintenant nécessaire : relancer la mise à jour";
  }
  return null;
}

/** A version/recipe stack already at (or past) the pinned target, e.g. applied by an earlier queued job. */
export function reached(pinned: PinnedTarget, fresh: StackStatus): boolean {
  return (
    fresh.mode !== "pull" &&
    pinned.available !== null &&
    fresh.current !== null &&
    compareVersions(fresh.current, pinned.available) >= 0
  );
}
