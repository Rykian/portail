import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stacksResponseSchema, type JobEvent } from "@shared/updater-api";
import { NotFoundError } from "./common/errors";
import { DetectionService } from "./detection/detection.service";
import { BusyError, JobRunner } from "./jobs/job-runner";
import { JobStore } from "./jobs/job.store";
import { SchedulerService } from "./scheduler/scheduler.service";
import { testModuleBuilder } from "./test/module";
import { UpdateService } from "./update/update.service";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let app: INestApplication;
let base: string;
let calls: unknown[][];
let updateImpl: () => Promise<unknown>;
let returned: boolean;
let release = () => {};

const events: JobEvent[] = [
  { type: "log", line: "hello" },
  { type: "step", step: { stack: "web", status: "running", from: null, to: null } },
  { type: "end", status: "success" },
];

const stub = {
  stacks: () => ({ stacks: [], lastCheck: null, configError: null, runningJob: null }),
  update: (...args: unknown[]) => {
    calls.push(["update", ...args]);
    return updateImpl();
  },
  history: (cursor: number | null) => {
    calls.push(["history", cursor]);
    return { jobs: [], nextCursor: null };
  },
  events: (id: number) =>
    id === 3
      ? {
          [Symbol.asyncIterator]: () => {
            let sent = false;
            return {
              next: () =>
                sent
                  ? new Promise((resolve) => (release = () => resolve({ value: undefined, done: true })))
                  : ((sent = true), Promise.resolve({ value: events[0], done: false })),
              return: async () => {
                returned = true;
                release();
                return { value: undefined, done: true };
              },
            };
          },
        }
      : id === 1
        ? {
            [Symbol.asyncIterator]: () => {
              let index = 0;
              return {
                next: async () =>
                  index < events.length ? { value: events[index++], done: false } : { value: undefined, done: true },
                return: async () => {
                  returned = true;
                  return { value: undefined, done: true };
                },
              };
            },
          }
        : null,
};

beforeEach(async () => {
  calls = [];
  returned = false;
  updateImpl = async () => ({ jobId: 7 });
  const moduleRef = await testModuleBuilder()
    .overrideProvider(DetectionService)
    .useValue({ stacks: stub.stacks })
    .overrideProvider(UpdateService)
    .useValue({ update: stub.update })
    .overrideProvider(JobStore)
    .useValue({ history: stub.history })
    .overrideProvider(JobRunner)
    .useValue({ events: stub.events })
    .overrideProvider(SchedulerService)
    .useValue({})
    .compile();
  app = moduleRef.createNestApplication({ logger: ["error", "warn"] });
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  base = base.replace("[::1]", "127.0.0.1");
});

afterEach(async () => {
  await app.close();
});

test("GET /health needs no token", async () => {
  const response = await fetch(`${base}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test("GET /stacks needs the token", async () => {
  expect((await fetch(`${base}/stacks`)).status).toBe(401);
  expect((await fetch(`${base}/stacks`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await fetch(`${base}/stacks`, { headers: { authorization: "Bearer secret-tokem" } })).status).toBe(401);
  const response = await fetch(`${base}/stacks`, { headers: auth });
  expect(response.status).toBe(200);
  expect(stacksResponseSchema.parse(await response.json())).toMatchObject({ stacks: [] });
});

test("POST update maps errors and passes the user", async () => {
  const ok = await fetch(`${base}/stacks/x/update`, {
    method: "POST",
    headers: { ...auth, "x-updater-user": "a@b.c" },
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ jobId: 7 });
  expect(calls).toEqual([["update", "x", {}, "a@b.c"]]);

  updateImpl = async () => {
    throw new BusyError();
  };
  const busy = await fetch(`${base}/stacks/x/update`, { method: "POST", headers: auth });
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "Une tâche est déjà en cours" });
  expect(calls[1]).toEqual(["update", "x", {}, null]);

  updateImpl = async () => {
    throw new NotFoundError("Stack inconnue : x");
  };
  const missing = await fetch(`${base}/stacks/x/update`, { method: "POST", headers: auth });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Stack inconnue : x" });
});

test("POST update validates the body", async () => {
  const response = await fetch(`${base}/stacks/x/update`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "yes" }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: expect.any(String) });

  const confirmed = await fetch(`${base}/stacks/x/update`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  expect(confirmed.status).toBe(200);
  expect(calls.at(-1)).toEqual(["update", "x", { confirm: true }, null]);
});

test("GET /jobs/:id/events streams SSE until end", async () => {
  const response = await fetch(`${base}/jobs/1/events`, { headers: auth });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toBe(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

  const missing = await fetch(`${base}/jobs/2/events`, { headers: auth });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: expect.any(String) });
});

test("GET /jobs/:id/events stops following when the client goes away", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/jobs/3/events`, { headers: auth, signal: controller.signal });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toBe(`data: ${JSON.stringify(events[0])}\n\n`);
  controller.abort();
  await vi.waitFor(() => expect(returned).toBe(true));
});

test("GET /history passes the cursor", async () => {
  await fetch(`${base}/history?cursor=5`, { headers: auth });
  await fetch(`${base}/history`, { headers: auth });
  await fetch(`${base}/history?cursor=abc`, { headers: auth });
  expect(calls).toEqual([
    ["history", 5],
    ["history", null],
    ["history", null],
  ]);
});
