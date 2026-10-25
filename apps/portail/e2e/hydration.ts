import type { Page } from "@playwright/test";

// Under `next dev`, `load` can fire before React hydrates, and a click that lands first is lost.
// React tags `<body>` once hydration starts; from then on it replays early events itself.
export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => Object.keys(document.body).some((key) => key.startsWith("__reactProps$")));
}
