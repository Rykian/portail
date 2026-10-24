import { expect, test } from "vitest";
import { jobEventSchema, stackStatusSchema, updateResponseSchema, updateBodySchema } from "./updater-api";

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
