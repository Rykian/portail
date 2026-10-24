import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
