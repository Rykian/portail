import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // The package throws outside a react-server bundle; tests import server modules directly.
      // Root node_modules: bunfig.toml installs with the hoisted linker.
      "server-only": fileURLToPath(new URL("../../node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["*.test.ts", "lib/**/*.test.ts", "app/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
