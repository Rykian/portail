import type { ServiceStatus, StackStatus } from "@portail/shared/updater-api";
import { expect, test } from "vitest";
import { pinTarget, staleReason } from "./target";

const service = (name: string, overrides: Partial<ServiceStatus> = {}): ServiceStatus => ({
  name,
  image: `ghcr.io/o/${name}:latest`,
  kind: "floating",
  current: null,
  available: null,
  newImageDate: null,
  update: true,
  error: null,
  ...overrides,
});

const status = (overrides: Partial<StackStatus> = {}): StackStatus => ({
  name: "immich",
  mode: "pull",
  confirm: false,
  last: false,
  recipe: null,
  services: [],
  update: true,
  button: true,
  current: null,
  available: null,
  major: false,
  needsConfirm: false,
  rollback: null,
  selectable: true,
  serviceRollbacks: [],
  error: null,
  checkedAt: null,
  ...overrides,
});

const mealie = (available: string | null) =>
  status({ name: "mealie", mode: "version", current: "v3.4.0", available, selectable: false });

const immich = (server: Partial<ServiceStatus>, ml: Partial<ServiceStatus> = {}) =>
  status({
    services: [
      service("server", { current: "1.0", available: "1.1", ...server }),
      service("machine-learning", { newImageDate: "2026-10-01T00:00:00Z", ...ml }),
    ],
  });

test("pinTarget keeps the stack target and the selected services only", () => {
  expect(pinTarget(mealie("v3.5.0"), null, true)).toEqual({
    stack: "mealie",
    available: "v3.5.0",
    services: [],
    confirmed: true,
  });
  expect(pinTarget(immich({}), ["machine-learning"], false)).toEqual({
    stack: "immich",
    available: null,
    services: [{ name: "machine-learning", available: null, newImageDate: "2026-10-01T00:00:00Z" }],
    confirmed: false,
  });
});

test("same target → null", () => {
  expect(staleReason(pinTarget(mealie("v3.5.0"), null, false), mealie("v3.5.0"), false)).toBeNull();
  const selection = ["server", "machine-learning"];
  expect(staleReason(pinTarget(immich({}), selection, false), immich({}), false)).toBeNull();
});

test("new variable target → changed message", () => {
  expect(staleReason(pinTarget(mealie("v3.5.0"), null, true), mealie("v4.0.0"), true)).toBe(
    "la cible a changé depuis la demande (v3.5.0 → v4.0.0) : relancer la mise à jour",
  );
});

test("newer floating image → changed message", () => {
  const pinned = pinTarget(immich({}), ["server", "machine-learning"], false);
  expect(staleReason(pinned, immich({}, { newImageDate: "2026-10-05T00:00:00Z" }), false)).toBe(
    "la cible a changé depuis la demande (2026-10-01T00:00:00Z → 2026-10-05T00:00:00Z) : relancer la mise à jour",
  );
  expect(staleReason(pinned, immich({ available: "1.2" }), false)).toBe(
    "la cible a changé depuis la demande (1.1 → 1.2) : relancer la mise à jour",
  );
});

test("a pinned service no longer out of date is not a change", () => {
  const pinned = pinTarget(immich({}), ["server", "machine-learning"], false);
  const fresh = immich({ current: "1.1", available: null, update: false });
  expect(staleReason(pinned, fresh, false)).toBeNull();
  // An unselected service with a newer image does not matter either.
  expect(staleReason(pinTarget(immich({}), ["server"], false), immich({}, { newImageDate: "2026-11-01" }), false)).toBe(
    null,
  );
});

test("needs a confirmation that was not given", () => {
  expect(staleReason(pinTarget(mealie("v3.5.0"), null, false), mealie("v3.5.0"), true)).toBe(
    "une confirmation est maintenant nécessaire : relancer la mise à jour",
  );
  expect(staleReason(pinTarget(mealie("v3.5.0"), null, true), mealie("v3.5.0"), true)).toBeNull();
});
