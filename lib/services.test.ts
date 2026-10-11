import { mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceLoader, parseConfig } from "./services";

const valid = `
sections: [Maison, Infrastructure]
services:
  - name: Home Assistant
    url: https://ha.payoux.net
    icon: home-assistant
    section: Maison
    description: La maison connectée.
    groups: [family]
    reach: everywhere
`;

const otherValid = valid.replace("Home Assistant", "Maison connectée");

describe("parseConfig", () => {
  it("accepts a valid file", () => {
    const config = parseConfig(valid);
    expect(config.sections).toEqual(["Maison", "Infrastructure"]);
    expect(config.services[0]).toMatchObject({ name: "Home Assistant", reach: "everywhere" });
  });

  it.each([
    ["unknown section", valid.replace("section: Maison", "section: Garage")],
    ["duplicate section", valid.replace("[Maison, Infrastructure]", "[Maison, Maison]")],
    ["empty groups", valid.replace("groups: [family]", "groups: []")],
    ["bad reach", valid.replace("reach: everywhere", "reach: partout")],
    ["bad icon slug", valid.replace("icon: home-assistant", "icon: Home Assistant.png")],
    ["bad url", valid.replace("url: https://ha.payoux.net", "url: ha.payoux.net")],
    ["not yaml", "sections: [unterminated"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseConfig(text)).toThrow();
  });
});

describe("createServiceLoader", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "portail-"));
    file = path.join(dir, "services.yml");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeWithMtime(text: string, seconds: number) {
    await writeFile(file, text);
    await utimes(file, seconds, seconds);
  }

  it("loads a valid file", async () => {
    await writeWithMtime(valid, 1_000);
    const load = createServiceLoader(file);
    expect((await load()).services[0].name).toBe("Home Assistant");
  });

  it("reloads when the modification time changes", async () => {
    await writeWithMtime(valid, 1_000);
    const load = createServiceLoader(file);
    await load();
    await writeWithMtime(otherValid, 2_000);
    expect((await load()).services[0].name).toBe("Maison connectée");
  });

  it("does not re-read when the modification time is unchanged", async () => {
    await writeWithMtime(valid, 1_000);
    const load = createServiceLoader(file);
    await load();
    await writeWithMtime(otherValid, 1_000);
    expect((await load()).services[0].name).toBe("Home Assistant");
  });

  it("keeps the last good version when the file becomes invalid", async () => {
    await writeWithMtime(valid, 1_000);
    const load = createServiceLoader(file);
    await load();
    await writeWithMtime("sections: [", 2_000);
    expect((await load()).services[0].name).toBe("Home Assistant");
    expect(console.error).toHaveBeenCalled();
  });

  it("keeps the last good version when the file disappears", async () => {
    await writeWithMtime(valid, 1_000);
    const load = createServiceLoader(file);
    await load();
    await unlink(file);
    expect((await load()).services[0].name).toBe("Home Assistant");
  });

  it("throws when nothing good was ever loaded", async () => {
    await writeWithMtime("sections: [", 1_000);
    await expect(createServiceLoader(file)()).rejects.toThrow();
    await expect(createServiceLoader(path.join(dir, "missing.yml"))()).rejects.toThrow();
  });
});
