// Fake updater for the Playwright e2e run: `node e2e/fake-updater.mts` (Node strips the types).
// Plain node:http, no import from the repo. Extend `routes` for new endpoints.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = 3101;
const TOKEN = "e2e-token";
const CHECKED_AT = "2026-10-24T08:00:00.000Z";

type Reply = { status: number; body: unknown };
type Route = (request: IncomingMessage, url: URL, response: ServerResponse) => Reply | Promise<Reply> | null;

let down = false;
// Last `x-updater-user` seen on a POST, exposed at `GET /__last-user` for the e2e tests.
let lastUser: string | null = null;

function service(
  name: string,
  image: string,
  kind: "floating" | "variable" | "literal" | "pinned",
  fields: { current?: string; available?: string; newImageDate?: string; update?: boolean } = {},
) {
  return {
    name,
    image,
    kind,
    current: fields.current ?? null,
    available: fields.available ?? null,
    newImageDate: fields.newImageDate ?? null,
    update: fields.update ?? false,
    error: null,
  };
}

function stack(
  name: string,
  mode: "pull" | "version" | "recipe",
  services: ReturnType<typeof service>[],
  fields: {
    update?: boolean;
    button?: boolean;
    current?: string;
    available?: string;
    needsConfirm?: boolean;
    confirm?: boolean;
    last?: boolean;
    recipe?: "authentik";
  } = {},
) {
  return {
    name,
    mode,
    confirm: fields.confirm ?? false,
    last: fields.last ?? false,
    recipe: fields.recipe ?? null,
    services,
    update: fields.update ?? false,
    button: fields.button ?? false,
    current: fields.current ?? null,
    available: fields.available ?? null,
    major: false,
    needsConfirm: fields.needsConfirm ?? false,
    rollback: null,
    error: null,
    checkedAt: CHECKED_AT,
  };
}

const stacks = [
  stack(
    "stirling",
    "pull",
    [
      service("stirling-pdf", "docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest", "floating", {
        update: true,
        newImageDate: "2026-10-20T00:00:00.000Z",
      }),
    ],
    { update: true, button: true },
  ),
  stack(
    "mealie",
    "version",
    [
      service("mealie", "ghcr.io/mealie-recipes/mealie:${VERSION}", "variable", {
        current: "v3.4.0",
        available: "v3.5.0",
        update: true,
      }),
    ],
    { update: true, button: true, current: "v3.4.0", available: "v3.5.0" },
  ),
  stack(
    "group-gate",
    "pull",
    [
      service("nginx", "nginx:1.31.6-alpine", "literal", {
        current: "1.31.6-alpine",
        available: "1.31.7-alpine",
        update: true,
      }),
    ],
    { update: true, button: false, current: "1.31.6-alpine", available: "1.31.7-alpine" },
  ),
  stack(
    "authentik",
    "recipe",
    [
      service("server", "ghcr.io/goauthentik/server:${AUTHENTIK_TAG}", "variable", {
        current: "2026.8.4",
        available: "2026.10.2",
        update: true,
      }),
      service("worker", "ghcr.io/goauthentik/server:${AUTHENTIK_TAG}", "variable", {
        current: "2026.8.4",
        available: "2026.10.2",
        update: true,
      }),
    ],
    {
      update: true,
      button: true,
      current: "2026.8.4",
      available: "2026.10.2",
      needsConfirm: true,
      last: true,
      recipe: "authentik",
    },
  ),
  stack("cloudflared", "pull", [service("cloudflared", "cloudflare/cloudflared:latest", "floating")]),
];

const routes: Record<string, Route> = {
  "GET /stacks": () => ({
    status: 200,
    body: { stacks, lastCheck: CHECKED_AT, configError: null, runningJob: null },
  }),
  "POST /checks": () => ({ status: 200, body: { jobId: 1 } }),
};

function send(response: ServerResponse, { status, body }: Reply) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
  const key = `${request.method} ${url.pathname}`;

  if (key === "GET /health") return send(response, { status: 200, body: { ok: true } });
  if (key === "POST /__down") {
    down = true;
    return send(response, { status: 200, body: { down } });
  }
  if (key === "GET /__last-user") return send(response, { status: 200, body: { user: lastUser } });
  if (down) return send(response, { status: 503, body: { error: "down" } });
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(response, { status: 401, body: { error: "unauthorized" } });
  }

  if (request.method === "POST") lastUser = request.headers["x-updater-user"]?.toString() ?? null;
  const reply = await routes[key]?.(request, url, response);
  // A route that streams (SSE) answers on `response` itself and returns null.
  if (reply === null) return;
  send(response, reply ?? { status: 404, body: { error: "not found" } });
});

server.listen(PORT, () => console.log(`fake updater on http://localhost:${PORT}`));
