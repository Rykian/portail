import type { ImageRef } from "./image-ref";

export interface Registry {
  digest(ref: ImageRef): Promise<string>;
  details(ref: ImageRef): Promise<{ version: string | null; created: string | null }>;
  tags(ref: ImageRef): Promise<string[]>;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const VERSION_LABEL = "org.opencontainers.image.version";

type Manifest = {
  manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
  config?: { digest: string };
};

type ConfigBlob = { created?: string; config?: { Labels?: Record<string, string> | null } };

export function createHttpRegistry(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Registry {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const tokens = new Map<string, string>();

  const send = (url: string | URL, init: RequestInit) =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

  async function fetchToken(challenge: string, ref: ImageRef): Promise<string> {
    const param = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];
    const realm = param("realm");
    if (!realm) throw new Error(`Registry auth challenge without realm for ${describe(ref)}`);
    const url = new URL(realm);
    const service = param("service");
    if (service) url.searchParams.set("service", service);
    url.searchParams.set("scope", param("scope") ?? `repository:${ref.repository}:pull`);
    const response = await send(url, { method: "GET" });
    if (!response.ok) throw failure(response.status, ref);
    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`Registry token response without token for ${describe(ref)}`);
    return token;
  }

  async function request(ref: ImageRef, url: URL, method: string, accept: string, reference: string) {
    const key = `${ref.registry}/${ref.repository}`;
    const attempt = () => {
      const headers: Record<string, string> = { Accept: accept };
      const token = tokens.get(key);
      if (token) headers.Authorization = `Bearer ${token}`;
      return send(url, { method, headers, redirect: "manual" });
    };

    let response = await attempt();
    if (response.status === 401 && !tokens.has(key)) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      tokens.set(key, await fetchToken(challenge, ref));
      response = await attempt();
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const target = new URL(location, url);
        const headers: Record<string, string> = { Accept: accept };
        const token = tokens.get(key);
        if (token && target.host === url.host) headers.Authorization = `Bearer ${token}`;
        response = await send(target, { method, headers });
      }
    }
    if (!response.ok) throw failure(response.status, ref, reference);
    return response;
  }

  const v2 = (ref: ImageRef, path: string) => new URL(`https://${ref.registry}/v2/${ref.repository}/${path}`);
  const reference = (ref: ImageRef) => ref.digest ?? ref.tag;

  async function getManifest(ref: ImageRef, ref2: string): Promise<Manifest> {
    const response = await request(ref, v2(ref, `manifests/${ref2}`), "GET", MANIFEST_ACCEPT, ref2);
    return (await response.json()) as Manifest;
  }

  return {
    async digest(ref) {
      const response = await request(
        ref,
        v2(ref, `manifests/${reference(ref)}`),
        "HEAD",
        MANIFEST_ACCEPT,
        reference(ref),
      );
      const digest = response.headers.get("docker-content-digest");
      if (!digest) throw new Error(`No Docker-Content-Digest for ${describe(ref)}`);
      return digest;
    },

    async details(ref) {
      let manifest = await getManifest(ref, reference(ref));
      if (manifest.manifests) {
        const amd64 = manifest.manifests.find((m) => m.platform?.os === "linux" && m.platform.architecture === "amd64");
        if (!amd64) throw new Error(`No linux/amd64 manifest for ${describe(ref)}`);
        manifest = await getManifest(ref, amd64.digest);
      }
      if (!manifest.config) throw new Error(`Manifest without config for ${describe(ref)}`);
      const response = await request(
        ref,
        v2(ref, `blobs/${manifest.config.digest}`),
        "GET",
        "application/json",
        reference(ref),
      );
      const config = (await response.json()) as ConfigBlob;
      return { version: config.config?.Labels?.[VERSION_LABEL] ?? null, created: config.created ?? null };
    },

    async tags(ref) {
      const all: string[] = [];
      let url: URL | null = v2(ref, "tags/list?n=1000");
      while (url) {
        const response = await request(ref, url, "GET", "application/json", "tags");
        const body = (await response.json()) as { tags?: string[] | null };
        all.push(...(body.tags ?? []));
        const next = /<([^>]+)>\s*;\s*rel="?next"?/.exec(response.headers.get("link") ?? "")?.[1];
        url = next ? new URL(next, url) : null;
      }
      return all;
    },
  };

  function describe(ref: ImageRef, reference_ = reference(ref)) {
    return `${ref.registry}/${ref.repository}:${reference_}`;
  }

  function failure(status: number, ref: ImageRef, reference_ = reference(ref)) {
    return new Error(`Registry responded ${status} for ${describe(ref, reference_)}`);
  }
}
