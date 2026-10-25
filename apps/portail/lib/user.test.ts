import { describe, expect, it } from "vitest";
import { devUser, groupsFromProfile, initials } from "./user";

describe("devUser", () => {
  it("returns the fake user in development when groups are configured", () => {
    expect(devUser({ NODE_ENV: "development", DEV_USER_GROUPS: "family, authentik Admins" })).toEqual({
      name: "Dev",
      email: "dev@localhost",
      image: null,
      groups: ["family", "authentik Admins"],
    });
  });
  it("lets a request header override the groups in development", () => {
    expect(devUser({ NODE_ENV: "development", DEV_USER_GROUPS: "family" }, "authentik Admins")?.groups).toEqual([
      "authentik Admins",
    ]);
  });
  it("is off without configured groups", () => {
    expect(devUser({ NODE_ENV: "development" })).toBeNull();
    expect(devUser({ NODE_ENV: "development", DEV_USER_GROUPS: "" })).toBeNull();
  });
  it("is always off outside development, even with the header", () => {
    expect(devUser({ NODE_ENV: "production", DEV_USER_GROUPS: "family" }, "authentik Admins")).toBeNull();
    expect(devUser({ NODE_ENV: "test", DEV_USER_GROUPS: "family" })).toBeNull();
  });
});

describe("groupsFromProfile", () => {
  it("reads the groups claim", () => {
    expect(groupsFromProfile({ groups: ["family", "authentik Admins"] })).toEqual(["family", "authentik Admins"]);
  });
  it("returns no groups when the claim is missing or malformed", () => {
    expect(groupsFromProfile(undefined)).toEqual([]);
    expect(groupsFromProfile({})).toEqual([]);
    expect(groupsFromProfile({ groups: "family" })).toEqual([]);
    expect(groupsFromProfile({ groups: ["family", 3, null] })).toEqual(["family"]);
  });
});

describe("initials", () => {
  it("uses first and last word", () => expect(initials("Thibault Lacroux")).toBe("TL"));
  it("uses two letters of a single word", () => expect(initials("dev")).toBe("DE"));
  it("falls back to ? for an empty name", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
