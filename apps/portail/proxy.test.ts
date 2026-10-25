import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: (handler: unknown) => handler }));

const { config } = await import("./proxy");
const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it("guards the page and the icons", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/icons/plex")).toBe(true);
  });
  it("leaves sign-in and its error page open", () => {
    expect(matches("/login")).toBe(false);
    expect(matches("/api/auth/callback/authentik")).toBe(false);
    expect(matches("/auth-error")).toBe(false);
  });
});
