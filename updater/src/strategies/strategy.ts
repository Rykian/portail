import type { ContainerState } from "../docker/docker";
import type { RollbackData, RollbackKind } from "../stacks/rollback.store";
import type { StackContext } from "../stacks/stack-context";

/**
 * The stored rollback data of one kind. Not built with `Extract`: that makes `K` invariant,
 * and `UpdateStrategy<"pull">` must stay assignable to `UpdateStrategy`.
 */
export type RollbackOf<K extends RollbackKind> = { [D in RollbackData as D["kind"]]: D }[K];

export type Plan<K extends RollbackKind = RollbackKind> = {
  /** Version a rollback brings back, shown to the user. */
  rollbackTo: string;
  rollback: RollbackOf<K>;
  /** Writes the change; runs after the `before` commands and before pull/up. */
  apply(): Promise<void>;
};

/** One way of updating a stack. Holds only what differs; the shared flow is StackUpdater. */
export interface UpdateStrategy<K extends RollbackKind = RollbackKind> {
  /** The `data.kind` its rollbacks are stored under. */
  readonly kind: K;
  /** Checks the target and returns the plan. Fails (via `fail`) before any file change. */
  prepare(ctx: StackContext, before: ContainerState[]): Promise<Plan<K>>;
  /** Text the user confirms before applying; only Authentik minor has one. */
  preview?(ctx: StackContext): Promise<string>;
  /** Puts back what `prepare` saved, then recreates the containers when `start`. */
  restore(ctx: StackContext, data: RollbackOf<K>, start: boolean): Promise<void>;
}

export const notNewerMessage = (target: string, value: string, file: string): string =>
  `la version ${target} n'est pas plus récente que ${value} déjà dans ${file} : mise à jour annulée`;
