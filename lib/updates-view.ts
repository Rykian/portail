import type { StackStatus } from "@/shared/updater-api";

export type StackRow =
  | { kind: "up-to-date" }
  | { kind: "rollback-only" }
  | { kind: "error"; message: string }
  | { kind: "literal"; label: string }
  | { kind: "update"; label: string; detail: string | null };

const imageDate = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC" });

function versions(stack: StackStatus): string | null {
  const from = stack.current ?? stack.services.find((s) => s.update)?.current;
  const to = stack.available ?? stack.services.find((s) => s.update)?.available;
  return from && to ? `${from} → ${to}` : null;
}

/** What the table and the cards show for a stack. */
export function stackRow(stack: StackStatus): StackRow {
  if (stack.error) return { kind: "error", message: stack.error };
  if (!stack.update) return stack.rollback ? { kind: "rollback-only" } : { kind: "up-to-date" };
  if (!stack.button) return { kind: "literal", label: `nouvelle version disponible : ${versions(stack) ?? "?"}` };

  const change = versions(stack);
  if (change) return { kind: "update", label: change, detail: null };
  const updated = stack.services.filter((s) => s.update);
  const [only] = updated;
  if (updated.length === 1 && only.newImageDate) {
    return {
      kind: "update",
      label: `nouvelle image du ${imageDate.format(new Date(only.newImageDate))}`,
      detail: null,
    };
  }
  return { kind: "update", label: "nouvelles images", detail: updated.map((s) => s.name).join(", ") };
}

/** Same rule as the updater's « Tout mettre à jour » plan. */
export function updateAllCount(stacks: StackStatus[]): number {
  return stacks.filter((s) => s.update && s.button && !s.needsConfirm && !s.error).length;
}
