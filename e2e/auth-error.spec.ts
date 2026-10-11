import { expect, test } from "@playwright/test";

test("a sign-in error stops at an error page instead of looping back to Authentik", async ({ page }) => {
  await page.goto("/login?error=OAuthCallbackError&callbackUrl=%2F");

  await expect(page).toHaveURL("/auth-error?error=OAuthCallbackError");
  await expect(page.getByText("La connexion a été refusée ou annulée")).toBeVisible();
  await expect(page.getByRole("link", { name: "Réessayer" })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Se déconnecter d’Authentik" })).toHaveAttribute(
    "href",
    "https://auth.payoux.net/application/o/portail/end-session/",
  );
});
