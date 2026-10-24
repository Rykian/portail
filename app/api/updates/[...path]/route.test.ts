import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getUser } from "@/auth";
import type { PortalUser } from "@/lib/user";
import { GET, POST } from "./route";

vi.mock("@/auth", () => ({ getUser: vi.fn() }));

const admin: PortalUser = { name: "A", email: "a@payoux.net", image: null, groups: ["authentik Admins"] };
const fetch = vi.fn();

function context(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

function post(origin: string | null) {
  const headers = origin ? { origin } : undefined;
  return new NextRequest("https://portail.payoux.net/api/updates/checks", { method: "POST", headers, body: "{}" });
}

beforeEach(() => {
  vi.stubEnv("UPDATER_URL", "http://updater:8080");
  vi.stubEnv("UPDATER_TOKEN", "secret");
  vi.stubEnv("AUTH_URL", "https://portail.payoux.net");
  vi.stubGlobal("fetch", fetch);
  vi.mocked(getUser).mockResolvedValue(admin);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetch.mockReset();
});

test("a non-admin gets a 404 and nothing is forwarded", async () => {
  vi.mocked(getUser).mockResolvedValue({ ...admin, groups: ["family"] });
  const response = await GET(new NextRequest("https://portail.payoux.net/api/updates/stacks"), context("stacks"));
  expect(response.status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([null, "https://stirling.payoux.net"])(
  "a POST from origin %s is refused, never forwarded",
  async (origin) => {
    const response = await POST(post(origin), context("checks"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Origine refusée" });
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("a POST from a user without e-mail is refused", async () => {
  vi.mocked(getUser).mockResolvedValue({ ...admin, email: "" });
  const response = await POST(post("https://portail.payoux.net"), context("checks"));
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

test("a same-origin POST is forwarded with the user", async () => {
  fetch.mockResolvedValue(Response.json({ jobId: 1 }));
  const response = await POST(post("https://portail.payoux.net"), context("checks"));
  expect(response.status).toBe(200);
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://updater:8080/checks");
  expect(new Headers(init.headers).get("x-updater-user")).toBe("a@payoux.net");
});

test("an unreachable updater gives a 502", async () => {
  fetch.mockRejectedValue(new TypeError("fetch failed"));
  const response = await GET(new NextRequest("https://portail.payoux.net/api/updates/stacks"), context("stacks"));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Service de mise à jour injoignable" });
});
