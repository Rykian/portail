import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-error";

describe("authErrorMessage", () => {
  it("explains a refused or cancelled sign-in", () => {
    expect(authErrorMessage("OAuthCallbackError")).toMatch(/refusée ou annulée/);
  });
  it("explains a denied account", () => {
    expect(authErrorMessage("AccessDenied")).toMatch(/n’a pas accès/);
  });
  it("explains a configuration problem", () => {
    expect(authErrorMessage("Configuration")).toMatch(/configuration/);
  });
  it("falls back to a generic message for unknown or missing codes", () => {
    const generic = authErrorMessage(null);
    expect(generic).toMatch(/La connexion a échoué/);
    expect(authErrorMessage("<script>")).toBe(generic);
    expect(authErrorMessage("toString")).toBe(generic);
  });
});
