import { match } from "ts-pattern";
import {
  MIGRATION_WARNING,
  type ImageProgress,
  type JobStatus,
  type JobStep,
  type PendingJob,
  type ServiceKind,
  type ServiceRollback,
  type ServiceStatus,
  type StackStatus,
} from "@portail/shared/updater-api";

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

/** Rolling back a stack that may have migrated its database is risky: same warning as the update confirmation. */
export function rollbackWarning(stack: StackStatus): string | null {
  // `major` of the update itself: the status after it compares the new version and no longer reports one.
  return stack.confirm || stack.recipe !== null || stack.rollback?.major ? MIGRATION_WARNING : null;
}

/** Rolling back one image: its own `major`, or what makes every rollback of the stack risky. */
export function serviceRollbackWarning(stack: StackStatus, point: ServiceRollback): string | null {
  return stack.confirm || stack.recipe !== null || point.major ? MIGRATION_WARNING : null;
}

export function serviceKindLabel(kind: ServiceKind): string {
  return match(kind)
    .with("floating", () => "flottante")
    .with("variable", () => "variable")
    .with("literal", () => "version en dur")
    .with("pinned", () => "figée")
    .exhaustive();
}

/** What changes for a service with an update: its versions, else the date of its new image. */
export function serviceChange(service: ServiceStatus): string | null {
  if (!service.update) return null;
  if (service.current && service.available) return `${service.current} → ${service.available}`;
  return service.newImageDate ? `image du ${imageDate.format(new Date(service.newImageDate))}` : null;
}

/** The tag badge of an image; a digest reference shows as « @sha256 ». */
export function imageTag(image: string): string {
  if (image.includes("@")) return "@sha256";
  // A colon after the last slash is the tag; one before it belongs to a registry port.
  const name = image.slice(image.lastIndexOf("/") + 1);
  const colon = name.indexOf(":");
  return colon === -1 ? "latest" : name.slice(colon + 1);
}

/** Same rule as the updater: floating images with an update, on a stack that allows a selection. */
export function selectableServices(stack: StackStatus): string[] {
  if (!stack.selectable) return [];
  return stack.services.filter((s) => s.kind === "floating" && s.update).map((s) => s.name);
}

export function stackJobState(stack: string, pending: PendingJob[]): "running" | "queued" | null {
  const jobs = pending.filter((job) => job.targets.some((t) => t.stack === stack));
  if (jobs.some((job) => job.status === "running")) return "running";
  return jobs.length > 0 ? "queued" : null;
}

/** Services a queued or running job already targets: they cannot be selected again. */
export function lockedServices(stack: StackStatus, pending: PendingJob[]): Set<string> {
  const targets = pending.flatMap((job) => job.targets).filter((t) => t.stack === stack.name);
  return new Set(targets.flatMap((t) => t.services ?? selectableServices(stack)));
}

const decimal = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const ratio = (p: ImageProgress) => (p.total === 0 ? 0 : p.downloaded / p.total);

export function progressPercent(p: ImageProgress): number {
  return p.state === "downloading" ? Math.round(ratio(p) * 100) : 100;
}

export function progressLabel(p: ImageProgress): string {
  return match(p.state)
    .with("done", () => "téléchargée")
    .with("up-to-date", () => "déjà à jour")
    .with("downloading", () => {
      if (p.total === 0) return "…";
      const [unit, size] = p.total >= 1e9 ? ["Go", 1e9] : ["Mo", 1e6];
      return `${progressPercent(p)} % · ${decimal.format(p.downloaded / size)}/${decimal.format(p.total / size)} ${unit}`;
    })
    .exhaustive();
}

/** The total grows while layers are announced: keep the previous value until the new one shows more. */
export function mergeProgress(previous: ImageProgress | undefined, next: ImageProgress): ImageProgress {
  const goesBack = previous?.state === "downloading" && next.state === "downloading" && ratio(next) < ratio(previous);
  return goesBack ? previous : next;
}

export function stepTitle(step: JobStep): string {
  return step.services ? `${step.stack} (${step.services.join(", ")})` : step.stack;
}

export function jobFinished(status: JobStatus): boolean {
  return status !== "queued" && status !== "running";
}

export function statusLabel(status: JobStatus): string {
  return match(status)
    .with("queued", () => "en attente")
    .with("running", () => "en cours")
    .with("success", () => "réussie")
    .with("failed", () => "échouée")
    .with("interrupted", () => "interrompue")
    .exhaustive();
}

/**
 * A queued job's stream replays its pending steps at once: it is still waiting while nothing has run and the
 * stacks list says it is queued.
 */
export function jobPanelLabel(
  log: { status: JobStatus | null; lines: string[]; steps: JobStep[] },
  queued: boolean,
): string {
  if (log.status) return statusLabel(log.status);
  const started = log.lines.length > 0 || log.steps.some((s) => s.status !== "pending" && s.status !== "not-started");
  return queued && !started ? "en attente" : "en cours";
}
