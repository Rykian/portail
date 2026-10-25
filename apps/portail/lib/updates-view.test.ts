import { expect, test } from "vitest";
import { MIGRATION_WARNING, type ServiceStatus, type StackStatus } from "@portail/shared/updater-api";
import { rollbackWarning, stackRow, updateAllCount } from "./updates-view";

function service(fields: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: "app",
    image: "example/app:latest",
    kind: "floating",
    current: null,
    available: null,
    newImageDate: null,
    update: false,
    error: null,
    ...fields,
  };
}

function stack(fields: Partial<StackStatus> = {}): StackStatus {
  return {
    name: "app",
    mode: "pull",
    confirm: false,
    last: false,
    recipe: null,
    services: [service()],
    update: false,
    button: false,
    current: null,
    available: null,
    major: false,
    needsConfirm: false,
    rollback: null,
    error: null,
    checkedAt: null,
    ...fields,
  };
}

test("an up-to-date stack", () => {
  expect(stackRow(stack())).toEqual({ kind: "up-to-date" });
});

test("a version change", () => {
  expect(stackRow(stack({ update: true, button: true, current: "v3.4.0", available: "v3.5.0" }))).toEqual({
    kind: "update",
    label: "v3.4.0 → v3.5.0",
    detail: null,
  });
});

test("one new image with a date", () => {
  const row = stackRow(
    stack({
      update: true,
      button: true,
      services: [service({ update: true, newImageDate: "2026-10-20T00:00:00.000Z" })],
    }),
  );
  expect(row).toEqual({ kind: "update", label: "nouvelle image du 20/10/2026", detail: null });
});

test("several new images list the updated services", () => {
  const row = stackRow(
    stack({
      update: true,
      button: true,
      services: [
        service({ name: "radarr", update: true }),
        service({ name: "sonarr", update: true, newImageDate: "2026-10-20T00:00:00.000Z" }),
        service({ name: "gluetun" }),
      ],
    }),
  );
  expect(row).toEqual({ kind: "update", label: "nouvelles images", detail: "radarr, sonarr" });
});

test("a literal version: no button, a hint", () => {
  const row = stackRow(
    stack({
      update: true,
      button: false,
      current: "1.31.6-alpine",
      available: "1.31.7-alpine",
      services: [service({ kind: "literal", update: true })],
    }),
  );
  expect(row).toEqual({ kind: "literal", label: "nouvelle version disponible : 1.31.6-alpine → 1.31.7-alpine" });
});

test("an error wins", () => {
  expect(stackRow(stack({ update: true, button: true, error: "registre injoignable" }))).toEqual({
    kind: "error",
    message: "registre injoignable",
  });
});

test("a stack with a rollback and no update is not collapsed", () => {
  expect(stackRow(stack({ rollback: { to: "v3.4.0", major: false } }))).toEqual({ kind: "rollback-only" });
});

test("update-all counts only stacks it would update", () => {
  const stacks = [
    stack({ name: "a", update: true, button: true }),
    stack({ name: "b", update: true, button: false }),
    stack({ name: "c", update: true, button: true, needsConfirm: true }),
    stack({ name: "d", update: true, button: true, error: "boom" }),
    stack({ name: "e" }),
    stack({ name: "f", update: true, button: true }),
  ];
  expect(updateAllCount(stacks)).toBe(2);
});

test("the rollback warns about database migrations for confirm, recipe and major updates only", () => {
  expect(rollbackWarning(stack())).toBeNull();
  expect(rollbackWarning(stack({ confirm: true }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ recipe: "authentik" }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ rollback: { to: "v3.4.0", major: true } }))).toBe(MIGRATION_WARNING);
  expect(rollbackWarning(stack({ major: true, rollback: { to: "v3.4.0", major: false } }))).toBeNull();
});
