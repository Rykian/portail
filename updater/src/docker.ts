export type ComposeService = {
  name: string;
  /** Image with variables resolved. */
  image: string;
  /** Image as written in the compose file (`--no-interpolate`). */
  rawImage: string;
};

export type ContainerState = {
  service: string;
  state: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead";
  exitCode: number;
  health: "starting" | "healthy" | "unhealthy" | null;
  imageId: string;
};

export type LocalImage = {
  id: string;
  repoDigests: string[];
  version: string | null;
  created: string | null;
};

export type LogSink = (line: string) => void;

export interface Docker {
  composeServices(dir: string): Promise<ComposeService[]>;
  containers(project: string): Promise<ContainerState[]>;
  image(ref: string): Promise<LocalImage | null>;
  compose(dir: string, args: string[], log: LogSink): Promise<number>;
  shell(dir: string, command: string, log: LogSink): Promise<number>;
  tag(source: string, target: string): Promise<void>;
  removeImage(ref: string): Promise<void>;
}
