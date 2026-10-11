import { describe, expect, it } from "vitest";
import { parseOrigin, resolveOrigin } from "./origin";

describe("parseOrigin", () => {
  it("reads internet", () => expect(parseOrigin("internet")).toBe("internet"));
  it("reads lan", () => expect(parseOrigin("lan")).toBe("lan"));
  it("treats a missing header as lan", () => {
    expect(parseOrigin(null)).toBe("lan");
    expect(parseOrigin(undefined)).toBe("lan");
  });
  it("treats junk as lan", () => {
    expect(parseOrigin("INTERNET")).toBe("lan");
    expect(parseOrigin(" internet")).toBe("lan");
    expect(parseOrigin("wan")).toBe("lan");
  });
});

describe("resolveOrigin", () => {
  it("uses the header when present", () => {
    expect(resolveOrigin("internet", { NODE_ENV: "production" })).toBe("internet");
    expect(resolveOrigin("lan", { NODE_ENV: "development", DEV_ORIGIN: "internet" })).toBe("lan");
  });
  it("uses DEV_ORIGIN only in development when the header is missing", () => {
    expect(resolveOrigin(null, { NODE_ENV: "development", DEV_ORIGIN: "internet" })).toBe("internet");
    expect(resolveOrigin(null, { NODE_ENV: "production", DEV_ORIGIN: "internet" })).toBe("lan");
  });
});
