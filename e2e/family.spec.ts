import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("shows only family services, LAN-only ones dimmed from the internet", async ({ page }) => {
  const cards = page.getByTestId("service-card");
  await expect(cards).toHaveText([/Home Assistant/, /Donetick/, /Plex/]);

  const donetick = cards.filter({ hasText: "Donetick" });
  await expect(donetick).toHaveAttribute("data-dimmed", "true");
  await expect(donetick).toContainText("À la maison uniquement");
  await expect(cards.filter({ hasText: "Plex" })).toHaveAttribute("data-dimmed", "false");
});

test("menu has no Administration entry", async ({ page }) => {
  await page.getByRole("button", { name: "Menu du compte" }).click();
  await expect(page.getByRole("menuitem", { name: "Mon compte" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Se déconnecter" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Administration" })).toHaveCount(0);
});

test("no update badge, no updates entry, and the updater proxy does not exist", async ({ page, request }) => {
  await page.getByRole("button", { name: "Menu du compte" }).click();
  await expect(page.getByRole("menuitem", { name: "Se déconnecter" })).toBeVisible();
  await expect(page.getByLabel(/mises à jour/)).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Mises à jour/ })).toHaveCount(0);

  expect((await request.get("/api/updates/stacks")).status()).toBe(404);
});

test("a missing icon falls back to the initial tile", async ({ page }) => {
  const card = page.getByTestId("service-card").filter({ hasText: "Home Assistant" });
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card).toContainText("H");
});

test("typing / inside the search field types a slash", async ({ page }) => {
  const search = page.getByLabel("Rechercher");
  await search.click();
  await page.keyboard.type("a/b");
  await expect(search).toHaveValue("a/b");
});

test("a blank query shows everything", async ({ page }) => {
  await page.getByLabel("Rechercher").fill("   ");
  await expect(page.getByTestId("service-card")).toHaveCount(3);
});
