import { expect, test } from "vitest";
import { openDatabase } from "../database/database";
import { RollbackStore, type RollbackState } from "./rollback.store";

test("rollback round-trip", () => {
  const store = new RollbackStore(openDatabase(":memory:"));
  const state: RollbackState = {
    stack: "web",
    to: "1.0",
    major: false,
    running: true,
    data: { kind: "version", file: ".env", variable: "V", value: "1.0" },
  };
  expect(store.get("web")).toBeNull();
  store.save(state);
  expect(store.get("web")).toEqual(state);
  store.delete("web");
  expect(store.get("web")).toBeNull();
});
