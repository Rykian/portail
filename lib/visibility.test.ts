import { describe, expect, it } from "vitest";
import type { Config, Service } from "./services";
import { isAdmin, visibleSections } from "./visibility";

function service(name: string, section: string, groups: string[], reach: Service["reach"]): Service {
  return { name, url: `https://${name}.test`, icon: name, section, description: `${name} desc`, groups, reach };
}

const config: Config = {
  sections: ["Maison", "Médias", "Infrastructure"],
  services: [
    service("proxmox", "Infrastructure", ["authentik Admins"], "lan"),
    service("ha", "Maison", ["family"], "everywhere"),
    service("donetick", "Maison", ["family"], "lan"),
    service("frigate", "Maison", ["authentik Admins"], "everywhere"),
  ],
};

const names = (sections: ReturnType<typeof visibleSections>) =>
  sections.map((s) => [s.name, s.services.map((x) => x.name)]);

describe("visibleSections", () => {
  it("shows only services of the user's groups, in section order, dropping empty sections", () => {
    expect(names(visibleSections(config, ["family"], "lan"))).toEqual([["Maison", ["ha", "donetick"]]]);
  });

  it("shows the union of several groups", () => {
    expect(names(visibleSections(config, ["family", "authentik Admins"], "lan"))).toEqual([
      ["Maison", ["ha", "donetick", "frigate"]],
      ["Infrastructure", ["proxmox"]],
    ]);
  });

  it("shows nothing to a user without groups", () => {
    expect(visibleSections(config, [], "lan")).toEqual([]);
  });

  it("dims only LAN services seen from the internet", () => {
    const dimmed = (origin: "lan" | "internet") =>
      visibleSections(config, ["family"], origin)[0].services.map((s) => [s.name, s.dimmed]);
    expect(dimmed("lan")).toEqual([
      ["ha", false],
      ["donetick", false],
    ]);
    expect(dimmed("internet")).toEqual([
      ["ha", false],
      ["donetick", true],
    ]);
  });

  it("does not send groups or reach to the client", () => {
    const sent = visibleSections(config, ["family"], "lan")[0].services[0];
    expect(Object.keys(sent).sort()).toEqual(["description", "dimmed", "icon", "name", "section", "url"]);
  });
});

describe("isAdmin", () => {
  it("is true only with the admin group", () => {
    expect(isAdmin(["family", "authentik Admins"])).toBe(true);
    expect(isAdmin(["family"])).toBe(false);
    expect(isAdmin([])).toBe(false);
  });
});
