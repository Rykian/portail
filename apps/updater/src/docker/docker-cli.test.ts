import { expect, test } from "vitest";
import { commandEnv, parseComposeConfig, parseImageInspect, parseImageIds, parsePs, pipeLines } from "./docker-cli";

const resolved = JSON.stringify({
  name: "web",
  services: {
    app: { image: "ghcr.io/x/app:1.2.3", restart: "always" },
    db: { image: "postgres:16" },
    builder: { build: { context: "." } },
  },
});
const raw = JSON.stringify({
  name: "web",
  services: {
    app: { image: "ghcr.io/x/app:${APP_VERSION:-1.0.0}" },
    db: { image: "postgres:16" },
    builder: { build: { context: "." } },
  },
});

test("parseComposeConfig merges resolved and raw images, skips build-only services", () => {
  expect(parseComposeConfig(resolved, raw)).toEqual([
    { name: "app", image: "ghcr.io/x/app:1.2.3", rawImage: "ghcr.io/x/app:${APP_VERSION:-1.0.0}" },
    { name: "db", image: "postgres:16", rawImage: "postgres:16" },
  ]);
});

const psLine1 = {
  ID: "abc123",
  Name: "web-app-1",
  Service: "app",
  State: "running",
  ExitCode: 0,
  Health: "",
  Image: "ghcr.io/x/app:1.2.3",
};
const psLine2 = { ID: "def456", Name: "web-db-1", Service: "db", State: "exited", ExitCode: 1, Health: "unhealthy" };

test("parsePs reads one JSON object per line", () => {
  const text = `${JSON.stringify(psLine1)}\n${JSON.stringify(psLine2)}\n`;
  expect(parsePs(text)).toEqual([
    { id: "abc123", service: "app", state: "running", exitCode: 0, health: null },
    { id: "def456", service: "db", state: "exited", exitCode: 1, health: "unhealthy" },
  ]);
});

test("parsePs reads a JSON array and empty output", () => {
  expect(parsePs(JSON.stringify([psLine1]))).toHaveLength(1);
  expect(parsePs("")).toEqual([]);
  expect(parsePs("[]\n")).toEqual([]);
});

test("parseImageIds pairs inspect lines with container ids", () => {
  expect(parseImageIds(["abc123", "def456"], "sha256:aaa\nsha256:bbb\n")).toEqual(
    new Map([
      ["abc123", "sha256:aaa"],
      ["def456", "sha256:bbb"],
    ]),
  );
});

test("parseImageInspect reads id, digests, version label and created", () => {
  const text = JSON.stringify([
    {
      Id: "sha256:aaa",
      RepoTags: ["ghcr.io/x/app:1.2.3"],
      RepoDigests: ["ghcr.io/x/app@sha256:ddd"],
      Created: "2026-10-01T12:00:00.123Z",
      Config: { Labels: { "org.opencontainers.image.version": "1.2.3" } },
    },
  ]);
  expect(parseImageInspect(text)).toEqual({
    id: "sha256:aaa",
    repoDigests: ["ghcr.io/x/app@sha256:ddd"],
    version: "1.2.3",
    created: "2026-10-01T12:00:00.123Z",
  });
  const bare = JSON.stringify([{ Id: "sha256:b", RepoDigests: null, Config: { Labels: null } }]);
  expect(parseImageInspect(bare)).toEqual({ id: "sha256:b", repoDigests: [], version: null, created: null });
  expect(parseImageInspect("[]")).toBeNull();
});

test("pipeLines splits chunks into lines, flushing the last partial line", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of ["one\ntw", "o\r\nthr", "ee"]) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const lines: string[] = [];
  await pipeLines(stream, (line) => lines.push(line));
  expect(lines).toEqual(["one", "two", "three"]);
});

test("commandEnv keeps only PATH, HOME and DOCKER_* so the updater's own variables don't reach compose", () => {
  expect(
    commandEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      PORT: "8080",
      NODE_ENV: "production",
      UPDATER_TOKEN: "secret",
      UNSET: undefined,
    }),
  ).toEqual({ PATH: "/usr/bin", HOME: "/root", DOCKER_HOST: "unix:///var/run/docker.sock" });
});
