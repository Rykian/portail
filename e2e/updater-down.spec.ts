import { expect, test } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  expect((await request.post("http://localhost:3101/__down")).ok()).toBe(true);
});

test("the home page still works, without the update pill", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("service-card")).toHaveCount(5);
  await expect(page.getByTestId("updates-badge")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu du compte", exact: true })).toBeVisible();
});

test("the updates page says the updater is unreachable", async ({ page }) => {
  await page.goto("/admin/updates");
  await expect(page.getByText("Le service de mise à jour est injoignable.")).toBeVisible();
});
