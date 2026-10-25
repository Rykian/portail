import { expect, test } from "vitest";
import { authentikTarget } from "./authentik-target";

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
