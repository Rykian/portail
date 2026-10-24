import { expect, test } from "vitest";
import { parseImageRef } from "./image-ref";
import { createHttpRegistry } from "./registry";

type Call = { url: string; method: string; headers: Headers };
type Handler = (call: Call) => Response;

function setup(handler: Handler) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, registry: createHttpRegistry({ fetch: fakeFetch }) };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

const CHALLENGE =
  'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"';
const MANIFEST = "https://registry-1.docker.io/v2/library/nginx/manifests/";

const nginx = parseImageRef("nginx:latest");

function authedHandler(inner: Handler): Handler {
  return (call) => {
    if (call.url.startsWith("https://auth.docker.io/token")) return json({ token: "tok" });
    if (call.url.startsWith("https://cdn.example.com/")) return inner(call);
    if (call.headers.get("authorization") !== "Bearer tok") {
      return new Response(null, { status: 401, headers: { "www-authenticate": CHALLENGE } });
    }
    return inner(call);
  };
}

test("digest: answers the bearer challenge, sends Accept, reuses the token", async () => {
  const { calls, registry } = setup(
    authedHandler(() => new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:abc" } })),
  );
  expect(await registry.digest(nginx)).toBe("sha256:abc");
  expect(await registry.digest(nginx)).toBe("sha256:abc");

  expect(calls[0]).toMatchObject({ method: "HEAD", url: `${MANIFEST}latest` });
  const tokenCalls = calls.filter((c) => c.url.startsWith("https://auth.docker.io/token"));
  expect(tokenCalls).toHaveLength(1);
  const tokenUrl = new URL(tokenCalls[0]!.url);
  expect(tokenUrl.searchParams.get("service")).toBe("registry.docker.io");
  expect(tokenUrl.searchParams.get("scope")).toBe("repository:library/nginx:pull");
  const accept = calls[0]!.headers.get("accept") ?? "";
  for (const type of [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ]) {
    expect(accept).toContain(type);
  }
  expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer tok");
});

test("a second 401 after authenticating throws", async () => {
  const { registry } = setup((call) =>
    call.url.startsWith("https://auth.docker.io/token")
      ? json({ access_token: "tok" })
      : new Response(null, { status: 401, headers: { "www-authenticate": CHALLENGE } }),
  );
  await expect(registry.digest(nginx)).rejects.toThrow(/401/);
});

test("tags follows Link pagination", async () => {
  const { calls, registry } = setup(
    authedHandler((call) =>
      !call.url.includes("last=")
        ? json({ tags: ["a", "b"] }, { link: '</v2/library/nginx/tags/list?n=1000&last=b>; rel="next"' })
        : json({ tags: ["c"] }),
    ),
  );
  expect(await registry.tags(nginx)).toEqual(["a", "b", "c"]);
  expect(calls.at(-1)!.url).toBe("https://registry-1.docker.io/v2/library/nginx/tags/list?n=1000&last=b");
});

const configBlob = (labels: Record<string, string> | undefined) => ({
  created: "2026-01-02T03:04:05Z",
  config: labels ? { Labels: labels } : {},
});

test("details: index -> linux/amd64 manifest -> config blob", async () => {
  const { calls, registry } = setup(
    authedHandler((call) => {
      if (call.url === `${MANIFEST}latest`)
        return json({
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
            { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
            { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
          ],
        });
      if (call.url === `${MANIFEST}sha256:amd`)
        return json({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: "sha256:cfg" } });
      if (call.url === "https://registry-1.docker.io/v2/library/nginx/blobs/sha256:cfg")
        return json(configBlob({ "org.opencontainers.image.version": "1.2.3" }));
      return new Response(null, { status: 404 });
    }),
  );
  expect(await registry.details(nginx)).toEqual({ version: "1.2.3", created: "2026-01-02T03:04:05Z" });
  expect(calls.some((c) => c.url.endsWith("sha256:arm"))).toBe(false);
});

test("details: single manifest, missing label -> version null", async () => {
  const { registry } = setup(
    authedHandler((call) =>
      call.url === `${MANIFEST}latest`
        ? json({ mediaType: "application/vnd.docker.distribution.manifest.v2+json", config: { digest: "sha256:cfg" } })
        : json(configBlob({})),
    ),
  );
  expect(await registry.details(nginx)).toEqual({ version: null, created: "2026-01-02T03:04:05Z" });
});

test("details: blob redirect to another host drops Authorization", async () => {
  const { calls, registry } = setup(
    authedHandler((call) => {
      if (call.url === `${MANIFEST}latest`)
        return json({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: "sha256:cfg" } });
      if (call.url.startsWith("https://registry-1.docker.io/v2/library/nginx/blobs/"))
        return new Response(null, { status: 307, headers: { location: "https://cdn.example.com/blob" } });
      return json(configBlob({ "org.opencontainers.image.version": "9" }));
    }),
  );
  expect((await registry.details(nginx)).version).toBe("9");
  const cdn = calls.find((c) => c.url === "https://cdn.example.com/blob")!;
  expect(cdn.headers.get("authorization")).toBeNull();
});

test("non-2xx throws with status and image", async () => {
  const { registry } = setup(() => new Response(null, { status: 429 }));
  await expect(registry.digest(nginx)).rejects.toThrow(/429.*registry-1\.docker\.io\/library\/nginx:latest/);
});
