import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposeService, ContainerState, Docker, LocalImage } from "../docker";
import type { ImageRef } from "../image-ref";
import type { Registry } from "../registry";

export function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "updater-test-"));
}

export class FakeDocker implements Docker {
  /** composeServices result per stack dir; an Error is thrown. */
  services = new Map<string, ComposeService[] | Error>();
  /** containers() result per project, used when containersSequence is exhausted. */
  containersByProject = new Map<string, ContainerState[]>();
  /** Successive containers() results, consumed one per call (any project). */
  containersSequence: ContainerState[][] = [];
  /** Local images by reference; missing = null. */
  images = new Map<string, LocalImage>();
  /** Recorded compose(dir, args) calls. */
  composeCalls: { dir: string; args: string[] }[] = [];
  /** Recorded shell(dir, command) calls. */
  shellCalls: { dir: string; command: string }[] = [];
  /** Recorded tag(source, target) calls. */
  tagCalls: { source: string; target: string }[] = [];
  /** Recorded removeImage(ref) calls. */
  removeImageCalls: string[] = [];
  /** Exit code returned by compose(); default 0. */
  composeExit: (args: string[]) => number = () => 0;
  /** Exit code returned by shell(); default 0. */
  shellExit: (command: string) => number = () => 0;

  async composeServices(dir: string): Promise<ComposeService[]> {
    const result = this.services.get(dir);
    if (result === undefined) throw new Error(`no compose services scripted for ${dir}`);
    if (result instanceof Error) throw result;
    return result;
  }

  async containers(project: string): Promise<ContainerState[]> {
    return this.containersSequence.shift() ?? this.containersByProject.get(project) ?? [];
  }

  async image(ref: string): Promise<LocalImage | null> {
    return this.images.get(ref) ?? null;
  }

  async compose(dir: string, args: string[]): Promise<number> {
    this.composeCalls.push({ dir, args });
    return this.composeExit(args);
  }

  async shell(dir: string, command: string): Promise<number> {
    this.shellCalls.push({ dir, command });
    return this.shellExit(command);
  }

  async tag(source: string, target: string): Promise<void> {
    this.tagCalls.push({ source, target });
  }

  async removeImage(ref: string): Promise<void> {
    this.removeImageCalls.push(ref);
  }
}

export class FakeRegistry implements Registry {
  /** Digests keyed by "<repository>:<reference>" (tag, or digest when pinned). */
  digests = new Map<string, string>();
  /** details() results keyed by "<repository>:<reference>". */
  detailsByRef = new Map<string, { version: string | null; created: string | null }>();
  /** Tag lists keyed by repository. */
  tagsByRepository = new Map<string, string[]>();
  /** Errors thrown by any call on a repository. */
  errors = new Map<string, Error>();
  /** Recorded calls, e.g. "details:library/nginx:latest". */
  calls: string[] = [];

  private check(method: string, ref: ImageRef) {
    this.calls.push(`${method}:${ref.repository}:${ref.digest ?? ref.tag}`);
    const error = this.errors.get(ref.repository);
    if (error) throw error;
  }

  async digest(ref: ImageRef): Promise<string> {
    this.check("digest", ref);
    const digest = this.digests.get(`${ref.repository}:${ref.digest ?? ref.tag}`);
    if (!digest) throw new Error(`no digest scripted for ${ref.repository}:${ref.digest ?? ref.tag}`);
    return digest;
  }

  async details(ref: ImageRef) {
    this.check("details", ref);
    return this.detailsByRef.get(`${ref.repository}:${ref.digest ?? ref.tag}`) ?? { version: null, created: null };
  }

  async tags(ref: ImageRef): Promise<string[]> {
    this.check("tags", ref);
    return this.tagsByRepository.get(ref.repository) ?? [];
  }
}
