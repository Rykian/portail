import { describe, expect, it } from "vitest";
import { filterSections, matches, normalize } from "./search";
import type { VisibleSection, VisibleService } from "./visibility";

const frigate: VisibleService = {
  name: "Frigate",
  url: "https://frigate.test",
  icon: "frigate",
  description: "La caméra de la sonnette",
  section: "Maison",
  dimmed: false,
};
const plex: VisibleService = { ...frigate, name: "Plex", description: "Nos films", section: "Médias" };

const sections: VisibleSection[] = [
  { name: "Maison", services: [frigate] },
  { name: "Médias", services: [plex] },
];

describe("normalize", () => {
  it("drops accents and case", () => expect(normalize("Caméra ÉTÉ")).toBe("camera ete"));
});

describe("matches", () => {
  it("ignores accents both ways", () => {
    expect(matches(frigate, "camera")).toBe(true);
    expect(matches(frigate, "CAMÉRA")).toBe(true);
  });
  it("matches name, description and section", () => {
    expect(matches(frigate, "frig")).toBe(true);
    expect(matches(frigate, "sonnette")).toBe(true);
    expect(matches(plex, "medias")).toBe(true);
  });
  it("rejects non-matching text", () => expect(matches(plex, "camera")).toBe(false));
  it("treats an empty or blank query as matching everything", () => {
    expect(matches(plex, "")).toBe(true);
    expect(matches(plex, "   ")).toBe(true);
  });
});

describe("filterSections", () => {
  it("drops sections with no match", () => {
    expect(filterSections(sections, "camera").map((s) => s.name)).toEqual(["Maison"]);
  });
  it("returns everything for a blank query", () => {
    expect(filterSections(sections, "  ")).toEqual(sections);
  });
});
