import { expect, test } from "vitest";
import { parseImageRef } from "./image-ref";

test("parses image references", () => {
  expect(parseImageRef("nginx")).toEqual({
    registry: "registry-1.docker.io",
    repository: "library/nginx",
    tag: "latest",
    digest: null,
  });
  expect(parseImageRef("docker.io/jc21/x:2")).toMatchObject({
    registry: "registry-1.docker.io",
    repository: "jc21/x",
    tag: "2",
  });
  expect(parseImageRef("lscr.io/linuxserver/sonarr:latest")).toMatchObject({
    registry: "lscr.io",
    repository: "linuxserver/sonarr",
  });
  expect(parseImageRef("ghcr.io/goauthentik/server:2026.8.3")).toMatchObject({
    registry: "ghcr.io",
    tag: "2026.8.3",
  });
  expect(parseImageRef("registry:5000/team/app")).toMatchObject({
    registry: "registry:5000",
    repository: "team/app",
    tag: "latest",
  });
  expect(parseImageRef("nginx:1.31.6-alpine@sha256:abc")).toMatchObject({
    tag: "1.31.6-alpine",
    digest: "sha256:abc",
  });
});
