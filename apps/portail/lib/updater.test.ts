import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchUpdateCount, updaterSettings } from "./updater";

function stack(name: string, update: boolean) {
  return {
    name,
    mode: "pull",
    confirm: false,
    last: false,
    recipe: null,
    services: [],
    update,
    button: update,
    current: null,
    available: null,
    major: false,
    needsConfirm: false,
    rollback: null,
    error: null,
    checkedAt: null,
  };
}

const body = {
  stacks: [stack("a", true), stack("b", false), stack("c", true)],
  lastCheck: null,
  configError: null,
  runningJob: null,
};

beforeEach(() => {
  vi.stubEnv("UPDATER_URL", "http://updater:8080/");
  vi.stubEnv("UPDATER_TOKEN", "secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("updaterSettings is null without configuration", () => {
  expect(updaterSettings({})).toBeNull();
  expect(updaterSettings({ UPDATER_URL: "http://updater:8080" })).toBeNull();
});

test("updaterSettings strips the trailing slash", () => {
  expect(updaterSettings({ UPDATER_URL: "http://updater:8080/", UPDATER_TOKEN: "t" })).toEqual({
    url: "http://updater:8080",
    token: "t",
  });
});

test("fetchUpdateCount counts stacks with an update and sends the token", async () => {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal("fetch", fetch);

  expect(await fetchUpdateCount()).toBe(2);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://updater:8080/stacks");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
});

test("fetchUpdateCount is null when the updater is not configured", async () => {
  vi.stubEnv("UPDATER_URL", "");
  vi.stubGlobal("fetch", vi.fn());
  expect(await fetchUpdateCount()).toBeNull();
});

test.each([
  ["fetch rejects", () => Promise.reject(new Error("ECONNREFUSED"))],
  ["503", async () => new Response("down", { status: 503 })],
  ["invalid body", async () => Response.json({ stacks: "nope" })],
])("fetchUpdateCount is null when %s", async (_name, impl) => {
  vi.stubGlobal("fetch", vi.fn(impl));
  expect(await fetchUpdateCount()).toBeNull();
});

test("fetchUpdateCount gives up after the timeout", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ),
  );

  let settled = false;
  const result = fetchUpdateCount().finally(() => (settled = true));
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeNull();
});
