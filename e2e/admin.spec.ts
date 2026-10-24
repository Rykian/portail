import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("shows family and admin services, nothing dimmed on the LAN", async ({ page }) => {
  await expect(page.getByTestId("service-card")).toHaveText([
    /Home Assistant/,
    /Donetick/,
    /Frigate/,
    /Plex/,
    /Proxmox/,
  ]);
  await expect(page.locator('[data-dimmed="true"]')).toHaveCount(0);
});

test("menu has the Administration entry", async ({ page }) => {
  await page.getByRole("button", { name: "Menu du compte" }).click();
  await expect(page.getByRole("menuitem", { name: "Administration" })).toBeVisible();
});

test("avatar shows the update count and the menu links to the updates page", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Menu du compte, 4 mises à jour", exact: true });
  await expect(page.getByTestId("updates-badge")).toHaveText("4");

  await trigger.click();
  const items = page.getByRole("menuitem");
  await expect(items).toHaveText(["Mon compte", "Administration", "Mises à jour (4)", "Se déconnecter"]);
  await expect(page.getByRole("menuitem", { name: "Mises à jour (4)" })).toHaveAttribute("href", "/admin/updates");
});

test("the proxy forwards admin requests to the updater", async ({ request, baseURL }) => {
  const stacks = await request.get("/api/updates/stacks");
  expect(stacks.status()).toBe(200);
  expect((await stacks.json()).stacks).toHaveLength(5);

  expect((await request.get("/api/updates/%2E%2E/health")).status()).toBe(404);

  const origin = new URL(baseURL!).origin;
  const check = await request.post("/api/updates/checks", { headers: { origin }, data: {} });
  expect(check.status()).toBe(200);
  expect(await check.json()).toEqual({ jobId: 1 });
  const last = await request.get("http://localhost:3101/__last-user");
  expect(await last.json()).toEqual({ user: "dev@localhost" });
});

test("the proxy refuses a POST without the portal origin", async ({ request }) => {
  const refused: Record<string, string>[] = [{}, { origin: "https://stirling.payoux.net" }];
  for (const headers of refused) {
    const response = await request.post("/api/updates/checks", { headers, data: {} });
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ error: "Origine refusée" });
  }
});

test("an existing icon is shown", async ({ page }) => {
  const card = page.getByTestId("service-card").filter({ hasText: "Frigate" });
  await expect(card.locator("img")).toBeVisible();
});

test("search: / focuses, accents ignored, Esc clears, Enter opens the first result", async ({ page }) => {
  const search = page.getByLabel("Rechercher");
  const cards = page.getByTestId("service-card");

  // The shortcut listener exists only once React has hydrated: retry until it does.
  await expect(async () => {
    await page.keyboard.press("/");
    await expect(search).toBeFocused({ timeout: 500 });
  }).toPass();
  await page.keyboard.type("camera");
  await expect(cards).toHaveText([/Frigate/]);

  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(search).not.toBeFocused();
  await expect(cards).toHaveCount(5);

  await page.keyboard.type("zzz");
  await expect(search).toHaveValue("");

  await page.keyboard.press("/");
  await page.keyboard.type("zzz");
  await expect(page.getByText("Aucun résultat pour « zzz »")).toBeVisible();

  await search.fill("plex");
  await page.route("https://plex.example.test/**", (route) => route.fulfill({ body: "plex" }));
  await page.keyboard.press("Enter");
  await page.waitForURL("https://plex.example.test/**");
});
