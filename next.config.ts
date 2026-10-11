import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // scripts/fetch-icons.mjs runs in the image and imports yaml.
  outputFileTracingIncludes: { "/": ["./node_modules/yaml/**"] },
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
