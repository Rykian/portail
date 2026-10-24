import { z } from "zod";
import type { ComposeService, ContainerState, Docker, LocalImage, LogSink } from "./docker";

type Captured = { code: number; stdout: string; stderr: string };
type PsEntry = Omit<ContainerState, "imageId"> & { id: string };

const composeConfigSchema = z.object({
  services: z.record(z.string(), z.object({ image: z.string().optional() }).loose()).default({}),
});

const psEntrySchema = z
  .object({
    ID: z.string(),
    Service: z.string(),
    State: z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]),
    ExitCode: z.number().default(0),
    Health: z
      .enum(["", "starting", "healthy", "unhealthy"])
      .default("")
      .transform((health) => (health === "" ? null : health)),
  })
  .loose();

const imageInspectSchema = z.array(
  z
    .object({
      Id: z.string(),
      RepoDigests: z.array(z.string()).nullish(),
      Created: z.string().nullish(),
      Config: z
        .object({ Labels: z.record(z.string(), z.string()).nullish() })
        .loose()
        .nullish(),
    })
    .loose(),
);

export function parseComposeConfig(resolvedJson: string, rawJson: string): ComposeService[] {
  const resolved = composeConfigSchema.parse(JSON.parse(resolvedJson)).services;
  const raw = composeConfigSchema.parse(JSON.parse(rawJson)).services;
  return Object.entries(resolved).flatMap(([name, service]) =>
    service.image ? [{ name, image: service.image, rawImage: raw[name]?.image ?? service.image }] : [],
  );
}

/** `docker compose ps --format json` prints one object per line (or, in some versions, one array). */
export function parsePs(text: string): PsEntry[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const items: unknown[] = trimmed.startsWith("[")
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown);
  return items.map((item) => {
    const entry = psEntrySchema.parse(item);
    return { id: entry.ID, service: entry.Service, state: entry.State, exitCode: entry.ExitCode, health: entry.Health };
  });
}

/** `docker inspect --format {{.Image}} <ids…>` prints one image id per container, in order. */
export function parseImageIds(ids: string[], text: string): Map<string, string> {
  const lines = text.trim().split("\n");
  return new Map(ids.map((id, index) => [id, lines[index]?.trim() ?? ""]));
}

export function parseImageInspect(text: string): LocalImage | null {
  const [image] = imageInspectSchema.parse(JSON.parse(text));
  if (!image) return null;
  return {
    id: image.Id,
    repoDigests: image.RepoDigests ?? [],
    version: image.Config?.Labels?.["org.opencontainers.image.version"] ?? null,
    created: image.Created ?? null,
  };
}

export async function pipeLines(stream: ReadableStream<Uint8Array>, log: LogSink): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) log(line);
  }
  buffer += decoder.decode();
  if (buffer !== "") log(buffer);
}

async function capture(args: string[], cwd?: string): Promise<Captured> {
  const proc = Bun.spawn(["docker", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function captureOk(args: string[], cwd?: string): Promise<string> {
  const result = await capture(args, cwd);
  if (result.code !== 0) {
    throw new Error(`docker ${args.join(" ")} a échoué (code ${result.code}) : ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function streamed(command: string[], cwd: string, log: LogSink): Promise<number> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  await Promise.all([pipeLines(proc.stdout, log), pipeLines(proc.stderr, log)]);
  return proc.exited;
}

export function createDockerCli(): Docker {
  return {
    async composeServices(dir) {
      const [resolved, raw] = await Promise.all([
        captureOk(["compose", "config", "--format", "json"], dir),
        captureOk(["compose", "config", "--no-interpolate", "--format", "json"], dir),
      ]);
      return parseComposeConfig(resolved, raw);
    },

    async containers(dir) {
      // Run from the stack directory: compose finds the project name itself (top-level `name:`, normalisation).
      const entries = parsePs(await captureOk(["compose", "ps", "-a", "--format", "json"], dir));
      if (entries.length === 0) return [];
      const ids = entries.map((entry) => entry.id);
      const images = parseImageIds(ids, await captureOk(["inspect", "--format", "{{.Image}}", ...ids]));
      return entries.map(({ id, ...entry }) => ({ ...entry, imageId: images.get(id) ?? "" }));
    },

    async image(ref) {
      const result = await capture(["image", "inspect", ref, "--format", "json"]);
      return result.code === 0 ? parseImageInspect(result.stdout) : null;
    },

    compose(dir, args, log) {
      return streamed(["docker", "compose", ...args], dir, log);
    },

    shell(dir, command, log) {
      return streamed(["sh", "-c", command], dir, log);
    },

    async tag(source, target) {
      await captureOk(["image", "tag", source, target]);
    },

    async removeImage(ref) {
      // A missing rollback tag must not fail an update or a rollback.
      const result = await capture(["image", "rm", ref]);
      if (result.code !== 0) console.warn(`docker image rm ${ref}: ${result.stderr.trim()}`);
    },
  };
}
