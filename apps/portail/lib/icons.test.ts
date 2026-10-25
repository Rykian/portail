import { describe, expect, it } from "vitest";
import { iconPath } from "./icons";

describe("iconPath", () => {
  it("maps a slug to a PNG in the directory", () => {
    expect(iconPath("/data/icons", "home-assistant")).toBe("/data/icons/home-assistant.png");
  });
  it.each(["", "..", "../etc/passwd", "Home", "a/b", "a.png", "a b", "a%2f"])("rejects %j", (name) => {
    expect(iconPath("/data/icons", name)).toBeNull();
  });
});
