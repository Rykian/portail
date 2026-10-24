import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await request.post("http://localhost:3101/__fail-events?count=0");
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

  // The job panel does not belong to the « Mises à jour » tab: switching tabs keeps it.
  await page.getByRole("tab", { name: "Historique" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("réussie");
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

test("authentik confirmed: the page sends the confirmation and the job runs", async ({ page }) => {
  await page.getByRole("button", { name: "Mettre à jour authentik" }).click();
  const dialog = page.getByRole("dialog", { name: "Mettre à jour authentik ?" });
  await dialog.getByRole("button", { name: "Confirmer" }).click();

  // The fake only starts job 2 when the POST body says `{ "confirm": true }`.
  await expect(page.getByRole("heading", { name: "Tâche n° 2" })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("authentik Pulled");
  await expect(page.getByTestId("job-status")).toHaveText("réussie");
});

test("the rollback confirmation warns about migrations only for stacks that may migrate", async ({ page }) => {
  await page.getByRole("button", { name: "Revenir à 2026.8.3" }).click();
  const authentik = page.getByRole("dialog", { name: "Revenir à 2026.8.3 ?" });
  await expect(authentik).toContainText("la vraie sauvegarde est le vzdump");
  await authentik.getByRole("button", { name: "Annuler" }).click();
  await expect(authentik).toHaveCount(0);

  await page.getByRole("button", { name: "Revenir à v3.3.0" }).click();
  const mealie = page.getByRole("dialog", { name: "Revenir à v3.3.0 ?" });
  await expect(mealie).toContainText("mealie reprendra sa version précédente.");
  await expect(mealie).not.toContainText("vzdump");
});

test("the job log recovers when its stream answers 502, e.g. while the portal restarts", async ({ page, request }) => {
  await request.post("http://localhost:3101/__fail-events?count=2");
  await page.getByRole("button", { name: "Mettre à jour stirling" }).click();
  await expect(page.getByText("Journal indisponible.")).toBeVisible();

  // The page polls the job every 3 s: the first poll finds it running, the second finds it done.
  await expect(page.getByTestId("job-status")).toHaveText("réussie", { timeout: 15_000 });
  const log = page.getByRole("log");
  await expect(log).toContainText("stirling Pulled");
  expect((await log.textContent())!.split("stirling Pulled")).toHaveLength(2);
  await expect(page.getByText("Journal indisponible.")).toHaveCount(0);
});

test("the history log dialog says when the log is unavailable, then recovers", async ({ page, request }) => {
  await page.getByRole("button", { name: "Mettre à jour stirling" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("réussie");

  await request.post("http://localhost:3101/__fail-events?count=1");
  await page.getByRole("tab", { name: "Historique" }).click();
  await page.getByTestId("history-row").filter({ hasText: "stirling" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Journal indisponible.")).toBeVisible();
  await expect(dialog.getByRole("log")).toContainText("== docker compose pull", { timeout: 15_000 });
  await expect(dialog.getByText("Journal indisponible.")).toHaveCount(0);
});

test("an unreadable event ends the log instead of breaking the page", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.getByRole("button", { name: "Mettre à jour mealie" }).click();
  await expect(page.getByText("Journal indisponible.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fermer" })).toBeVisible();
  expect(errors).toEqual([]);
});
