import { describe, expect, it } from "vitest";
import { iconSlugs, isPng } from "./fetch-icons.mjs";

describe("isPng", () => {
  it("accepts the PNG signature", () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(true);
  });
  it("rejects HTML and short files", () => {
    expect(isPng(new TextEncoder().encode("<!doctype html>"))).toBe(false);
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
  });
});

describe("iconSlugs", () => {
  it("returns unique valid slugs", () => {
    const config = {
      services: [{ icon: "plex" }, { icon: "plex" }, { icon: "home-assistant" }, { icon: "../x" }, {}],
    };
    expect(iconSlugs(config)).toEqual(["plex", "home-assistant"]);
  });
  it("handles a config without services", () => expect(iconSlugs({})).toEqual([]));
});
