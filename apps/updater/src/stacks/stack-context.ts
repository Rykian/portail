import type { ImageProgress, StackStatus } from "@portail/shared/updater-api";
import type { StackConfig } from "../config/config";
import type { LogSink } from "../docker/docker";
import type { DiscoveredStack } from "./discovery";

/** What one update or rollback run knows about its stack. Injected dependencies live in constructors, not here. */
export type StackContext = {
  stack: DiscoveredStack;
  config: StackConfig;
  status: StackStatus;
  /** Targeted services of a pull-style update (null: every selectable service); unused by version/recipe updates. */
  selection: string[] | null;
  log: LogSink;
  /** Download progress of each image; the job relays it, never logs it. */
  progress: (p: ImageProgress) => void;
};
