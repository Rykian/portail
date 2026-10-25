import { expect, test } from "vitest";
import { parseConfig, stackConfig } from "./config";

const example = `
exclude: [authelia, updater, wud, "*.back", "*.bak-*"]

stacks:
  mealie:
    version: { file: .env, variable: VERSION }
  authentik:
    recipe: authentik
    version: { file: .env, variable: AUTHENTIK_TAG }
  sure:
    confirm: true
    before:
      - docker compose exec -T db pg_dump -U sure sure > backups/sure-$(date +%F).sql
  downloads:
    before:
      - tar czf backups/seer-$(date +%F).tgz seer
    beforeOnlyOnMajor: true
  frigate: { confirm: true }
  traefik: { last: true }
  cloudflared: { last: true }
  portal: { last: true }
`;

test("parses the example config", () => {
  const config = parseConfig(example);
  expect(config.stacks.mealie.version).toEqual({ file: ".env", variable: "VERSION" });
  expect(config.stacks.frigate.confirm).toBe(true);
  expect(config.stacks.traefik.last).toBe(true);
  expect(config.stacks.downloads.beforeOnlyOnMajor).toBe(true);
  expect(config.exclude).toHaveLength(5);
});

test("empty text and {} give the empty config", () => {
  expect(parseConfig("")).toEqual({ exclude: [], stacks: {} });
  expect(parseConfig("{}")).toEqual({ exclude: [], stacks: {} });
});

test("rejects invalid configs", () => {
  expect(() => parseConfig("stacks: { x: { confrm: true } }")).toThrow();
  expect(() => parseConfig("stacks: { x: { recipe: authentik } }")).toThrow();
  expect(() => parseConfig('stacks: { x: { version: { file: .env, variable: "1BAD" } } }')).toThrow();
});

test("stackConfig returns defaults for an unknown stack", () => {
  expect(stackConfig(parseConfig(example), "unknown")).toEqual({
    confirm: false,
    last: false,
    before: [],
    beforeOnlyOnMajor: false,
  });
});
