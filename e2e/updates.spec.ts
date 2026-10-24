import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/admin/updates");
});

test("lists the stacks, collapses the up-to-date ones, explains literal versions", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Mises à jour" })).toBeVisible();
  await expect(page.getByText(/^Vérifié (il y a|à l’instant)/)).toBeVisible();
  await expect(page.getByTestId("stack-row")).toHaveText([/stirling/, /mealie/, /group-gate/, /authentik/]);

  const upToDate = page.getByRole("button", { name: "1 à jour" });
  await upToDate.click();
  await expect(page.getByText("cloudflared")).toBeVisible();

  const groupGate = page.getByTestId("stack-row").filter({ hasText: "group-gate" });
  await expect(groupGate).toContainText("nouvelle version disponible : 1.31.6-alpine → 1.31.7-alpine");
  await expect(groupGate).toContainText("Passer la version dans une variable pour l'activer");
  await expect(groupGate.getByRole("button")).toHaveCount(0);

  await expect(page.getByTestId("stack-row").filter({ hasText: "mealie" })).toContainText("v3.4.0 → v3.5.0");
  await expect(page.getByRole("button", { name: "Tout mettre à jour" })).toBeEnabled();
});

test("the card view is remembered", async ({ page }) => {
  await page.getByRole("button", { name: "Cartes" }).click();
  await expect(page.getByTestId("stack-card")).toHaveCount(5);

  await page.reload();
  await expect(page.getByRole("button", { name: "Cartes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("stack-card")).toHaveCount(5);
  await expect(page.getByTestId("stack-row")).toHaveCount(0);
});

test("updating stirling shows the log once, then the history lists it", async ({ page }) => {
  await page.getByRole("button", { name: "Mettre à jour stirling" }).click();

  const log = page.getByRole("log");
  await expect(log).toContainText("stirling Pulled");
  await expect(page.getByTestId("job-status")).toHaveText("réussie");
  expect((await log.textContent())!.split("stirling Pulled")).toHaveLength(2);

  await page.getByRole("tab", { name: "Historique" }).click();
  const row = page.getByTestId("history-row").filter({ hasText: "stirling" });
  await expect(row).toContainText("réussie");

  await row.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("log")).toContainText("== docker compose pull");
});

test("authentik asks for confirmation with the diff; cancelling starts nothing", async ({ page }) => {
  await page.getByRole("button", { name: "Mettre à jour authentik" }).click();

  const dialog = page.getByRole("dialog", { name: "Mettre à jour authentik ?" });
  await expect(dialog).toContainText("2026.8.4 → 2026.10.2");
  await expect(dialog.getByLabel("Différences")).toContainText("+    image: ghcr.io/goauthentik/server:2026.10");

  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("log")).toHaveCount(0);
});
