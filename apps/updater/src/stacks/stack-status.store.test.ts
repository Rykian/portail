import { expect, test } from "vitest";
import type { StackStatus } from "@portail/shared/updater-api";
import { openDatabase } from "../database/database";
import { StackStatusStore } from "./stack-status.store";

test("saveStackStatuses replaces all; meta", () => {
  const store = new StackStatusStore(openDatabase(":memory:"));
  const s = (name: string) => ({ name }) as unknown as StackStatus;
  store.saveStackStatuses([s("a"), s("b")]);
  store.saveStackStatuses([s("c")]);
  expect(store.stackStatuses()).toEqual([s("c")]);
  store.saveStackStatus(s("d"));
  expect(store.stackStatuses()).toHaveLength(2);
  expect(store.getMeta("k")).toBeNull();
  store.setMeta("k", "v");
  expect(store.getMeta("k")).toBe("v");
  store.setMeta("k", null);
  expect(store.getMeta("k")).toBeNull();
});
