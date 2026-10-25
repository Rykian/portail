import { Inject, Injectable } from "@nestjs/common";
import type { ServiceKind, StackStatus } from "@portail/shared/updater-api";
import { match } from "ts-pattern";
import type { StackConfig } from "../config/config";
import { isMajorBump, newestAbove } from "../docker/versions";
import type { PullPoint, RollbackData } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";
import { AuthentikMinorStrategy, minorOf } from "./authentik-minor.strategy";
import { authentikTarget } from "./authentik-target";
import { PullStrategy } from "./pull.strategy";
import type { UpdateStrategy } from "./strategy";
import { VersionStrategy } from "./version.strategy";

/** A recipe stack whose update crosses to another Authentik minor, which the user confirms. */
const isAuthentikMinor = (status: StackStatus): boolean =>
  status.mode === "recipe" &&
  status.needsConfirm &&
  status.current !== null &&
  status.available !== null &&
  minorOf(status.current) !== minorOf(status.available);

/** Stacks updated image by image: pull mode, or a version/recipe stack whose variable has no target (only a floating sidecar changed). */
const isPullStyle = (status: StackStatus, config: StackConfig): boolean =>
  status.mode === "pull" || (status.available === null && config.version !== undefined);

/** Services a pull-style update may target: floating ones with an update. Empty for other stacks. */
export function selectableServices(status: StackStatus, config: StackConfig): string[] {
  if (!isPullStyle(status, config)) return [];
  return status.services.filter((s) => s.kind === "floating" && s.update).map((s) => s.name);
}

/** Whether updating the selected services crosses a major version for any of them. */
export function selectionMajor(status: StackStatus, selection: string[]): boolean {
  return status.services.some(
    (s) =>
      selection.includes(s.name) && s.current !== null && s.available !== null && isMajorBump(s.current, s.available),
  );
}

/** Picks the way a stack is updated and what a check offers as the target. */
@Injectable()
export class Strategies {
  constructor(
    @Inject(PullStrategy) private readonly pull: PullStrategy,
    @Inject(VersionStrategy) private readonly version: VersionStrategy,
    @Inject(AuthentikMinorStrategy) private readonly authentikMinor: AuthentikMinorStrategy,
  ) {}

  /** Chosen per update from the last check's status, not per stack. */
  forUpdate(status: StackStatus, config: StackConfig): UpdateStrategy {
    if (isPullStyle(status, config)) return this.pull;
    if (isAuthentikMinor(status)) return this.authentikMinor;
    return this.version;
  }

  /** Puts back a stored stack-level rollback through the strategy that saved it, whatever the stack's mode is today. */
  restore(ctx: StackContext, data: RollbackData, start: boolean): Promise<void> {
    return match(data)
      .with({ kind: "version" }, (saved) => this.version.restore(ctx, saved, start))
      .with({ kind: "recipe" }, (saved) => this.authentikMinor.restore(ctx, saved, start))
      .exhaustive();
  }

  /** Puts back pull-style rollback points; returns the services it started. */
  restorePoints(ctx: StackContext, points: PullPoint[]): Promise<string[]> {
    return this.pull.restore(ctx, points);
  }

  /** The version a check offers for a service, and whether updating to it needs the user's confirmation. */
  target(
    config: StackConfig,
    kind: ServiceKind,
    tag: string,
    tags: string[],
  ): { to: string | null; needsConfirm: boolean } {
    if (config.recipe === "authentik" && kind === "variable") {
      const target = authentikTarget(tag, tags);
      return { to: target?.to ?? null, needsConfirm: target?.kind === "minor" };
    }
    return { to: newestAbove(tag, tags), needsConfirm: false };
  }
}
