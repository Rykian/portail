import { expect, test } from "vitest";
import { authentikTarget, isLiteralVersion, isMajorBump, newestAbove } from "./versions";

test("newestAbove keeps the same shape and returns the highest", () => {
  expect(
    newestAbove("1.31.6-alpine", ["1.31.7-alpine", "1.32.0", "1.32.0-alpine", "1.31.10-alpine", "mainline-alpine"]),
  ).toBe("1.32.0-alpine");
  expect(newestAbove("v3.4.0", ["v3.5.0", "3.6.0", "v3.10.0", "v3.10"])).toBe("v3.10.0");
  expect(newestAbove("v3.4.0", ["v3.3.0"])).toBeNull();
  expect(newestAbove("latest", ["1.0.0"])).toBeNull();
});

test("isMajorBump", () => {
  expect(isMajorBump("v3.4.0", "v4.0.0")).toBe(true);
  expect(isMajorBump("v3.4.0", "v3.5.0")).toBe(false);
  expect(isMajorBump("2026.8.3", "2027.1.0")).toBe(false);
});

test("isLiteralVersion", () => {
  expect(isLiteralVersion("v3.7")).toBe(false);
  expect(isLiteralVersion("1.31.6-alpine")).toBe(true);
});

test("authentikTarget", () => {
  const tags = ["2026.8.3", "2026.8.4", "2026.10.0", "2026.10.2", "2026.12.1", "2026.10.2-rc1", "latest"];
  expect(authentikTarget("2026.8.3", tags)).toEqual({
    kind: "patch",
    to: "2026.8.4",
  });
  expect(authentikTarget("2026.8.4", tags)).toEqual({
    kind: "minor",
    to: "2026.10.2",
  });
  expect(authentikTarget("2026.12.1", tags)).toBeNull();
});
