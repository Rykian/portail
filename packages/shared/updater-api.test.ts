import { expect, test } from "vitest";
import {
  jobEventSchema,
  rollbackBodySchema,
  stackStatusSchema,
  stacksResponseSchema,
  updateResponseSchema,
  updateBodySchema,
} from "./updater-api";

const validStack = {
  name: "authentik",
  mode: "recipe",
  confirm: false,
  last: true,
  recipe: "authentik",
  services: [
    {
      name: "server",
      image: "ghcr.io/goauthentik/server:2026.8.3",
      kind: "literal",
      current: "2026.8.3",
      available: "2026.10.1",
      newImageDate: "2026-10-20T08:00:00Z",
      update: true,
      error: null,
    },
  ],
  update: true,
  button: true,
  current: "2026.8.3",
  available: "2026.10.1",
  major: false,
  needsConfirm: true,
  rollback: null,
  selectable: false,
  serviceRollbacks: [],
  error: null,
  checkedAt: "2026-10-24T06:00:00Z",
};

test("JobEvent is discriminated on type", () => {
  expect(jobEventSchema.parse({ type: "end", status: "failed" })).toEqual({ type: "end", status: "failed" });
  expect(() => jobEventSchema.parse({ type: "end", status: "nope" })).toThrow();
});

test("UpdateResponse accepts both shapes", () => {
  expect(updateResponseSchema.parse({ jobId: 3 })).toEqual({ jobId: 3 });
  const preview = { needsConfirm: { from: "2026.8.3", to: "2026.10.1", diff: "--- a", warning: null } };
  expect(updateResponseSchema.parse(preview)).toEqual(preview);
});

test("StackStatus rejects an unknown mode", () => {
  expect(stackStatusSchema.parse(validStack)).toEqual(validStack);
  expect(() => stackStatusSchema.parse({ ...validStack, mode: "magic" })).toThrow();
});

test("UpdateBody is strict and only accepts confirm: true", () => {
  expect(updateBodySchema.parse({})).toEqual({});
  expect(updateBodySchema.parse({ confirm: true })).toEqual({ confirm: true });
  expect(() => updateBodySchema.parse({ confirm: false })).toThrow();
  expect(() => updateBodySchema.parse({ confirm: true, extra: 1 })).toThrow();
});

test("UpdateBody accepts a service selection, RollbackBody a single service", () => {
  expect(updateBodySchema.parse({ services: ["web"] })).toEqual({ services: ["web"] });
  expect(() => updateBodySchema.parse({ services: "web" })).toThrow();
  expect(rollbackBodySchema.parse({})).toEqual({});
  expect(rollbackBodySchema.parse({ service: "web" })).toEqual({ service: "web" });
  expect(() => rollbackBodySchema.parse({ service: "web", extra: 1 })).toThrow();
});

test("JobEvent carries image progress", () => {
  const progress = { stack: "web", service: "app", image: "x:1", downloaded: 10, total: 100, state: "downloading" };
  expect(jobEventSchema.parse({ type: "progress", progress })).toEqual({ type: "progress", progress });
  expect(() => jobEventSchema.parse({ type: "progress", progress: { ...progress, state: "nope" } })).toThrow();
  expect(jobEventSchema.parse({ type: "end", status: "queued" })).toEqual({ type: "end", status: "queued" });
});

test("StacksResponse lists the pending jobs", () => {
  const response = {
    stacks: [validStack],
    lastCheck: null,
    configError: null,
    runningJob: 4,
    pendingJobs: [
      { id: 4, kind: "update", status: "running", targets: [{ stack: "web", services: ["app"] }] },
      { id: 5, kind: "update-all", status: "queued", targets: [{ stack: "db", services: null }] },
    ],
  };
  expect(stacksResponseSchema.parse(response)).toEqual(response);
  expect(() =>
    stacksResponseSchema.parse({ ...response, pendingJobs: [{ ...response.pendingJobs[0], status: "success" }] }),
  ).toThrow();
});
