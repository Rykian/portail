import { z } from "zod";
import type { LogSink } from "./docker";
import { pipeLines } from "./docker-cli";
import { DOCKER_HUB, parseImageRef, type ImageRef } from "./image-ref";

export type PullResult = "downloaded" | "up-to-date";

export interface ImagePuller {
  pull(
    image: string,
    platform: string | null,
    onProgress: (downloaded: number, total: number) => void,
    log: LogSink,
  ): Promise<PullResult>;
}

/** Injection token for the image puller. */
export const IMAGE_PULLER = Symbol("IMAGE_PULLER");

const pullEventSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  progressDetail: z.object({ current: z.number().optional(), total: z.number().optional() }).optional(),
  error: z.string().optional(),
  errorDetail: z.object({ message: z.string().optional() }).optional(),
});

/** Statuses after which the layer is fully downloaded, whatever its progress events said. */
const LAYER_DONE = new Set(["Already exists", "Download complete", "Pull complete"]);

/**
 * Folds the `POST /images/create` stream into download progress: only the bytes of `Downloading` events count
 * (`Extracting` events carry progress too, summing them would fill the bar twice).
 */
export class PullTracker {
  private readonly layers = new Map<string, { current: number; total: number }>();
  private isUpToDate = false;
  private failure: string | null = null;

  update(event: unknown): void {
    const parsed = pullEventSchema.safeParse(event);
    if (!parsed.success) return;
    const { id, status, progressDetail, error, errorDetail } = parsed.data;

    const message = error ?? errorDetail?.message;
    if (message !== undefined) this.failure = message;
    if (status?.startsWith("Status: Image is up to date")) this.isUpToDate = true;
    if (id === undefined || status === undefined) return;

    const layer = this.layers.get(id) ?? { current: 0, total: 0 };
    this.layers.set(id, layer);
    if (status === "Downloading" && progressDetail?.total !== undefined && progressDetail.total > 0) {
      layer.total = progressDetail.total;
      layer.current = Math.min(progressDetail.current ?? 0, layer.total);
    } else if (LAYER_DONE.has(status)) {
      layer.current = layer.total;
    }
  }

  downloaded(): number {
    return [...this.layers.values()].reduce((sum, layer) => sum + layer.current, 0);
  }

  total(): number {
    return [...this.layers.values()].reduce((sum, layer) => sum + layer.total, 0);
  }

  upToDate(): boolean {
    return this.isUpToDate;
  }

  error(): string | null {
    return this.failure;
  }
}

const dockerConfigSchema = z.object({
  auths: z
    .record(z.string(), z.object({ auth: z.string().optional(), identitytoken: z.string().optional() }).loose())
    .optional(),
  credsStore: z.string().optional(),
  credHelpers: z.record(z.string(), z.string()).optional(),
});

/** The parts of `~/.docker/config.json` that decide how to authenticate to a registry. */
export type DockerConfig = z.infer<typeof dockerConfigSchema>;

export type RegistryAuth = { kind: "anonymous" } | { kind: "header"; value: string } | { kind: "helper" };

const HUB_CONFIG_KEY = "https://index.docker.io/v1/";
const HUB_HOSTS = new Set([DOCKER_HUB, "docker.io", "index.docker.io"]);

/** `X-Registry-Auth` is URL-safe base64 (padded) JSON. */
const authHeader = (credentials: Record<string, string>): RegistryAuth => ({
  kind: "header",
  value: Buffer.from(JSON.stringify(credentials)).toString("base64").replaceAll("+", "-").replaceAll("/", "_"),
});

/**
 * How to authenticate to `registry` with the CLI's config, in the CLI's order: a credential helper named for the
 * registry, then inline credentials, then the default `credsStore`. A helper is an executable only the CLI should run.
 */
export function registryAuth(config: DockerConfig, registry: string): RegistryAuth {
  const key = HUB_HOSTS.has(registry) ? HUB_CONFIG_KEY : registry;
  if (config.credHelpers?.[key]) return { kind: "helper" };

  const entry = config.auths?.[key] ?? config.auths?.[`https://${key}`];
  if (entry?.identitytoken) return authHeader({ identitytoken: entry.identitytoken, serveraddress: key });
  if (entry?.auth) {
    const [username = "", ...password] = Buffer.from(entry.auth, "base64").toString().split(":");
    return authHeader({ username, password: password.join(":"), serveraddress: key });
  }
  return config.credsStore ? { kind: "helper" } : { kind: "anonymous" };
}

async function readDockerConfig(path: string): Promise<DockerConfig> {
  const file = Bun.file(path);
  return (await file.exists()) ? dockerConfigSchema.parse(await file.json()) : {};
}

/** The image name as Docker expects it in `fromImage`: `nginx` for Docker Hub, `host/path` elsewhere. */
const fromImageOf = (ref: ImageRef) =>
  ref.registry === DOCKER_HUB ? ref.repository.replace(/^library\//, "") : `${ref.registry}/${ref.repository}`;

/**
 * Downloads images through the Docker Engine API on its Unix socket, which streams per-layer progress.
 * A registry whose credentials live in a credential helper goes through `cliPull` instead (no progress).
 */
export function createEnginePuller(options: {
  socket: string;
  dockerConfigPath: string;
  cliPull: (image: string, platform: string | null, log: LogSink) => Promise<number>;
}): ImagePuller {
  return {
    async pull(image, platform, onProgress, log) {
      const ref = parseImageRef(image);
      const auth = registryAuth(await readDockerConfig(options.dockerConfigPath), ref.registry);

      if (auth.kind === "helper") {
        const code = await options.cliPull(image, platform, log);
        if (code !== 0) throw new Error(`docker pull ${image} a échoué (code ${code})`);
        return "downloaded";
      }

      const query = new URLSearchParams({ fromImage: fromImageOf(ref), tag: ref.digest ?? ref.tag });
      if (platform) query.set("platform", platform);
      const response = await fetch(`http://docker/images/create?${query}`, {
        method: "POST",
        unix: options.socket,
        headers: auth.kind === "header" ? { "X-Registry-Auth": auth.value } : {},
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `Le téléchargement de ${image} a échoué (Docker ${response.status}) : ${await response.text()}`,
        );
      }

      const tracker = new PullTracker();
      await pipeLines(response.body, (line) => {
        if (line.trim() === "") return;
        const [downloaded, total] = [tracker.downloaded(), tracker.total()];
        tracker.update(JSON.parse(line));
        if (tracker.downloaded() !== downloaded || tracker.total() !== total) {
          onProgress(tracker.downloaded(), tracker.total());
        }
      });

      const failure = tracker.error();
      if (failure !== null) throw new Error(`Le téléchargement de ${image} a échoué : ${failure}`);
      return tracker.upToDate() ? "up-to-date" : "downloaded";
    },
  };
}
