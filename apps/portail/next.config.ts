import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@portail/shared"],
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // scripts/fetch-icons.mjs runs in the image and imports yaml.
  outputFileTracingIncludes: { "/": ["../../node_modules/yaml/**"] },
  // A restored dev cache makes Turbopack send HMR "restart"s that reload every open page: e2e runs start without it.
  experimental: { turbopackFileSystemCacheForDev: process.env.E2E !== "1" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
