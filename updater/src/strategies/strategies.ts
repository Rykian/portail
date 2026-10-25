import { Inject, Injectable } from "@nestjs/common";
import type { ServiceKind, StackStatus } from "@shared/updater-api";
import { match } from "ts-pattern";
import type { StackConfig } from "../config/config";
import { newestAbove } from "../docker/versions";
import type { RollbackData } from "../stacks/rollback.store";
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
    if (status.mode === "pull") return this.pull;
    // Version or recipe mode without a variable target (only a floating sidecar changed) updates like pull mode.
    if (status.available === null && config.version) return this.pull;
    if (isAuthentikMinor(status)) return this.authentikMinor;
    return this.version;
  }

  /** Puts back a stored rollback through the strategy that saved it, whatever the stack's mode is today. */
  restore(ctx: StackContext, data: RollbackData, start: boolean): Promise<void> {
    return match(data)
      .with({ kind: "pull" }, (saved) => this.pull.restore(ctx, saved, start))
      .with({ kind: "version" }, (saved) => this.version.restore(ctx, saved, start))
      .with({ kind: "recipe" }, (saved) => this.authentikMinor.restore(ctx, saved, start))
      .exhaustive();
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
