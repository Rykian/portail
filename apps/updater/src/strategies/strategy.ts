import type { ComposeService, ContainerState } from "../docker/docker";
import type { PullPoint, RollbackData, RollbackKind } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";

/**
 * The stored rollback data of one kind. Not built with `Extract`: that makes `K` invariant,
 * and `UpdateStrategy<"version">` must stay assignable to `UpdateStrategy`.
 */
export type RollbackOf<K extends RollbackKind> = { [D in RollbackData as D["kind"]]: D }[K];

/** A pull-style update: downloads and recreates the selected services only, with one rollback point each. */
export type PullPlan = {
  kind: "pull";
  /** Every service of the compose file, read before any change. */
  services: ComposeService[];
  /** Names of the targeted services. */
  selection: string[];
  /** Points of the targeted services that were running; their images are already tagged. */
  points: PullPoint[];
  /** Writes the change; runs after the `before` commands and before pull/up. */
  apply(): Promise<void>;
};

/** A version or recipe update: rewrites files, then the whole stack is downloaded and recreated. */
export type FilePlan<K extends RollbackKind> = {
  kind: K;
  /** Version a rollback brings back, shown to the user. */
  rollbackTo: string;
  rollback: RollbackOf<K>;
  /** Writes the change; runs after the `before` commands and before pull/up. */
  apply(): Promise<void>;
};

export type PlanKind = "pull" | RollbackKind;

export type Plan<K extends PlanKind = PlanKind> = K extends "pull"
  ? PullPlan
  : K extends RollbackKind
    ? FilePlan<K>
    : never;

/**
 * One way of updating a stack. Holds only what differs; the shared flow is StackUpdater.
 * Rollbacks go through `Strategies`: points to the pull strategy, stack-level data to the strategy that saved it.
 */
export interface UpdateStrategy<K extends PlanKind = PlanKind> {
  /** The plan kind it returns (and the `data.kind` of its stack-level rollbacks). */
  readonly kind: K;
  /** Checks the target, saves what a rollback needs (the pull strategy tags images) and returns the plan. Fails (via `fail`) before any file change. */
  prepare(ctx: StackContext, before: ContainerState[]): Promise<Plan<K>>;
  /** Text the user confirms before applying; only Authentik minor has one. */
  preview?(ctx: StackContext): Promise<string>;
}

export const notNewerMessage = (target: string, value: string, file: string): string =>
  `la version ${target} n'est pas plus récente que ${value} déjà dans ${file} : mise à jour annulée`;
