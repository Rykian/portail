import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { tempDir } from "../test/fakes";
import { createEnginePuller, PullTracker, registryAuth, type DockerConfig } from "./engine";

const feed = (tracker: PullTracker, ...events: unknown[]) => events.forEach((event) => tracker.update(event));

test("PullTracker counts only Downloading bytes", () => {
  const tracker = new PullTracker();
  feed(
    tracker,
    { id: "a", status: "Downloading", progressDetail: { current: 50, total: 100 } },
    { id: "a", status: "Extracting", progressDetail: { current: 80, total: 100 } },
    { id: "b", status: "Already exists", progressDetail: {} },
    { id: "c", status: "Downloading", progressDetail: { current: 10, total: 40 } },
  );
  expect(tracker.downloaded()).toBe(60);
  expect(tracker.total()).toBe(140);

  tracker.update({ id: "a", status: "Download complete", progressDetail: {} });
  expect(tracker.downloaded()).toBe(110);
  expect(tracker.total()).toBe(140);
});

test("PullTracker: Pull complete fills a layer to its known total", () => {
  const tracker = new PullTracker();
  feed(
    tracker,
    { id: "a", status: "Pulling fs layer", progressDetail: {} },
    { id: "a", status: "Downloading", progressDetail: { current: 30, total: 100 } },
    { id: "a", status: "Pull complete", progressDetail: {} },
  );
  expect(tracker.downloaded()).toBe(100);
  expect(tracker.total()).toBe(100);
});

test("PullTracker ignores events it does not understand", () => {
  const tracker = new PullTracker();
  feed(tracker, null, "text", { id: 3 }, { status: "Digest: sha256:abc" });
  expect(tracker.downloaded()).toBe(0);
  expect(tracker.total()).toBe(0);
  expect(tracker.upToDate()).toBe(false);
  expect(tracker.error()).toBeNull();
});

test("PullTracker detects up to date", () => {
  const tracker = new PullTracker();
  tracker.update({ status: "Status: Image is up to date for nginx:latest" });
  expect(tracker.upToDate()).toBe(true);
});

test("PullTracker reports the stream error", () => {
  const tracker = new PullTracker();
  tracker.update({ error: "manifest unknown", errorDetail: { message: "manifest unknown" } });
  expect(tracker.error()).toBe("manifest unknown");
});

const basic = Buffer.from("me:s3cret").toString("base64");
const decode = (value: string) => JSON.parse(Buffer.from(value, "base64").toString());

test("registryAuth is anonymous without a config entry", () => {
  expect(registryAuth({}, "ghcr.io")).toEqual({ kind: "anonymous" });
  expect(registryAuth({ auths: { "other.io": { auth: basic } } }, "ghcr.io")).toEqual({ kind: "anonymous" });
  expect(registryAuth({ auths: { "ghcr.io": {} } }, "ghcr.io")).toEqual({ kind: "anonymous" });
});

test("registryAuth builds the header from auths.auth", () => {
  const auth = registryAuth({ auths: { "ghcr.io": { auth: basic } } }, "ghcr.io");
  expect(auth.kind).toBe("header");
  expect(decode((auth as { value: string }).value)).toEqual({
    username: "me",
    password: "s3cret",
    serveraddress: "ghcr.io",
  });
});

test("registryAuth keeps a colon inside the password", () => {
  const config: DockerConfig = { auths: { "ghcr.io": { auth: Buffer.from("me:a:b").toString("base64") } } };
  const auth = registryAuth(config, "ghcr.io");
  expect(decode((auth as { value: string }).value)).toMatchObject({ username: "me", password: "a:b" });
});

test("registryAuth looks Docker Hub up as https://index.docker.io/v1/", () => {
  const config: DockerConfig = { auths: { "https://index.docker.io/v1/": { auth: basic } } };
  const auth = registryAuth(config, "registry-1.docker.io");
  expect(auth.kind).toBe("header");
  expect(decode((auth as { value: string }).value).serveraddress).toBe("https://index.docker.io/v1/");
  expect(registryAuth({ auths: { "registry-1.docker.io": { auth: basic } } }, "registry-1.docker.io")).toEqual({
    kind: "anonymous",
  });
});

test("registryAuth sends an identity token", () => {
  const auth = registryAuth({ auths: { "ghcr.io": { identitytoken: "tok" } } }, "ghcr.io");
  expect(decode((auth as { value: string }).value)).toEqual({ identitytoken: "tok", serveraddress: "ghcr.io" });
});

test("registryAuth uses a helper when credHelpers names the registry", () => {
  const config: DockerConfig = { credHelpers: { "ghcr.io": "osxkeychain" }, auths: { "ghcr.io": { auth: basic } } };
  expect(registryAuth(config, "ghcr.io")).toEqual({ kind: "helper" });
  expect(registryAuth(config, "quay.io")).toEqual({ kind: "anonymous" });
});

test("registryAuth uses a helper when credsStore is set and auths has no inline auth", () => {
  expect(registryAuth({ credsStore: "desktop" }, "ghcr.io")).toEqual({ kind: "helper" });
  expect(registryAuth({ credsStore: "desktop", auths: { "ghcr.io": {} } }, "ghcr.io")).toEqual({ kind: "helper" });
  expect(registryAuth({ credsStore: "desktop", auths: { "ghcr.io": { auth: basic } } }, "ghcr.io").kind).toBe("header");
});

type Request = { method: string; query: Record<string, string>; auth: string | null };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A fake Docker daemon on a Unix socket, answering every `POST /images/create` with `body`. */
async function startEngine(body: string, status = 200) {
  const dir = await tempDir();
  const socket = join(dir, "docker.sock");
  const requests: Request[] = [];
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/images/create") return new Response("not found", { status: 404 });
      requests.push({
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        auth: request.headers.get("x-registry-auth"),
      });
      return new Response(body, { status });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, socket, requests };
}

const ndjson = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const neverCli = async () => {
  throw new Error("the CLI must not be used");
};

test("createEnginePuller streams progress and returns downloaded", async () => {
  const engine = await startEngine(
    ndjson(
      { status: "Pulling from immich-app/immich-server", id: "release" },
      { id: "a", status: "Pulling fs layer", progressDetail: {} },
      { id: "a", status: "Downloading", progressDetail: { current: 25, total: 100 } },
      { id: "a", status: "Downloading", progressDetail: { current: 25, total: 100 } },
      { id: "a", status: "Download complete", progressDetail: {} },
      { id: "a", status: "Extracting", progressDetail: { current: 50, total: 100 } },
      { id: "a", status: "Pull complete", progressDetail: {} },
      { status: "Digest: sha256:abc" },
      { status: "Status: Downloaded newer image for ghcr.io/immich-app/immich-server:release" },
    ),
  );
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: join(engine.dir, "missing.json"),
    cliPull: neverCli,
  });
  const progress: [number, number][] = [];

  const result = await puller.pull(
    "ghcr.io/immich-app/immich-server:release",
    "linux/arm64",
    (downloaded, total) => progress.push([downloaded, total]),
    () => {},
  );

  expect(result).toBe("downloaded");
  expect(progress).toEqual([
    [25, 100],
    [100, 100],
  ]);
  expect(engine.requests).toEqual([
    {
      method: "POST",
      query: { fromImage: "ghcr.io/immich-app/immich-server", tag: "release", platform: "linux/arm64" },
      auth: null,
    },
  ]);
});

test("createEnginePuller returns up-to-date", async () => {
  const engine = await startEngine(
    ndjson(
      { id: "a", status: "Already exists", progressDetail: {} },
      { status: "Status: Image is up to date for nginx:latest" },
    ),
  );
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: join(engine.dir, "missing.json"),
    cliPull: neverCli,
  });

  expect(
    await puller.pull(
      "nginx",
      null,
      () => {},
      () => {},
    ),
  ).toBe("up-to-date");
  // Docker Hub is asked for by its familiar name, without the `library/` path nor a platform.
  expect(engine.requests[0]?.query).toEqual({ fromImage: "nginx", tag: "latest" });
});

test("createEnginePuller pulls a digest as the tag", async () => {
  const engine = await startEngine(ndjson({ status: "Status: Image is up to date for postgres@sha256:abc" }));
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: join(engine.dir, "missing.json"),
    cliPull: neverCli,
  });

  await puller.pull(
    "postgres@sha256:abc",
    null,
    () => {},
    () => {},
  );
  expect(engine.requests[0]?.query).toEqual({ fromImage: "postgres", tag: "sha256:abc" });
});

test("createEnginePuller sends the credentials of the Docker config", async () => {
  const engine = await startEngine(ndjson({ status: "Status: Downloaded newer image for ghcr.io/acme/app:1" }));
  const configPath = join(engine.dir, "config.json");
  await Bun.write(configPath, JSON.stringify({ auths: { "ghcr.io": { auth: basic } } }));
  const puller = createEnginePuller({ socket: engine.socket, dockerConfigPath: configPath, cliPull: neverCli });

  await puller.pull(
    "ghcr.io/acme/app:1",
    null,
    () => {},
    () => {},
  );

  expect(decode(engine.requests[0]?.auth ?? "")).toEqual({
    username: "me",
    password: "s3cret",
    serveraddress: "ghcr.io",
  });
});

test("createEnginePuller fails with the stream error", async () => {
  const engine = await startEngine(
    ndjson(
      { status: "Pulling from acme/app", id: "9" },
      { errorDetail: { message: "manifest unknown" }, error: "manifest unknown" },
    ),
  );
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: join(engine.dir, "missing.json"),
    cliPull: neverCli,
  });

  await expect(
    puller.pull(
      "ghcr.io/acme/app:9",
      null,
      () => {},
      () => {},
    ),
  ).rejects.toThrow(/manifest unknown/);
});

test("createEnginePuller fails when the daemon answers an error status", async () => {
  const engine = await startEngine(JSON.stringify({ message: "invalid reference format" }), 400);
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: join(engine.dir, "missing.json"),
    cliPull: neverCli,
  });

  await expect(
    puller.pull(
      "nginx",
      null,
      () => {},
      () => {},
    ),
  ).rejects.toThrow(/400.*invalid reference format/);
});

test("createEnginePuller falls back to the CLI when the registry uses a credential helper", async () => {
  const engine = await startEngine(ndjson({ status: "never asked" }));
  const configPath = join(engine.dir, "config.json");
  await Bun.write(configPath, JSON.stringify({ credHelpers: { "ghcr.io": "osxkeychain" } }));
  const cliCalls: string[] = [];
  let exitCode = 0;
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: configPath,
    cliPull: async (image, _platform, log) => {
      cliCalls.push(image);
      log("Pulling…");
      return exitCode;
    },
  });
  const progress: [number, number][] = [];
  const lines: string[] = [];

  const result = await puller.pull(
    "ghcr.io/acme/app:1",
    null,
    (downloaded, total) => progress.push([downloaded, total]),
    (line) => lines.push(line),
  );

  expect(result).toBe("downloaded");
  expect(cliCalls).toEqual(["ghcr.io/acme/app:1"]);
  expect(lines).toEqual(["Pulling…"]);
  expect(progress).toEqual([]);
  expect(engine.requests).toEqual([]);

  exitCode = 1;
  await expect(
    puller.pull(
      "ghcr.io/acme/app:1",
      null,
      () => {},
      () => {},
    ),
  ).rejects.toThrow("docker pull ghcr.io/acme/app:1 a échoué (code 1)");
});

test("createEnginePuller hands the platform to the CLI fallback", async () => {
  const engine = await startEngine(ndjson({ status: "never asked" }));
  const configPath = join(engine.dir, "config.json");
  await Bun.write(configPath, JSON.stringify({ credsStore: "desktop" }));
  const cliCalls: { image: string; platform: string | null }[] = [];
  const puller = createEnginePuller({
    socket: engine.socket,
    dockerConfigPath: configPath,
    cliPull: async (image, platform) => {
      cliCalls.push({ image, platform });
      return 0;
    },
  });

  await puller.pull(
    "ghcr.io/acme/app:1",
    "linux/arm64",
    () => {},
    () => {},
  );
  await puller.pull(
    "ghcr.io/acme/app:1",
    null,
    () => {},
    () => {},
  );

  expect(cliCalls).toEqual([
    { image: "ghcr.io/acme/app:1", platform: "linux/arm64" },
    { image: "ghcr.io/acme/app:1", platform: null },
  ]);
  expect(engine.requests).toEqual([]);
});
