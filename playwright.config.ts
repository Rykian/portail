import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${port}` },
  projects: [
    {
      name: "family-internet",
      testMatch: "family.spec.ts",
      use: { extraHTTPHeaders: { "x-dev-user-groups": "family", "x-portal-origin": "internet" } },
    },
    {
      name: "admin-lan",
      testMatch: "admin.spec.ts",
      use: { extraHTTPHeaders: { "x-dev-user-groups": "family,authentik Admins", "x-portal-origin": "lan" } },
    },
    {
      name: "login-error",
      testMatch: "auth-error.spec.ts",
    },
  ],
  webServer: [
    {
      command: "node e2e/fake-updater.mts",
      url: "http://localhost:3101/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npx next dev -p ${port}`,
      url: `http://localhost:${port}/favicon.ico`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        SERVICES_FILE: "e2e/fixtures/services.yml",
        ICONS_DIR: "e2e/fixtures/icons",
        DEV_USER_GROUPS: "family",
        AUTH_SECRET: "e2e-only-not-a-secret",
        UPDATER_URL: "http://localhost:3101",
        UPDATER_TOKEN: "e2e-token",
      },
    },
  ],
});
