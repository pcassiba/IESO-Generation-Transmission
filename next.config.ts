import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a WASM Postgres build and `pg` has optional native bindings: keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  devIndicators: false,
  // The API reads facility metadata and the transmission network from disk; ship them with the serverless functions.
  outputFileTracingIncludes: {
    "/api/**": ["./data/facilities/*.json", "./data/transmission/*.json", "./public/geo/*.geojson"],
  },
  // Cloudflare Workers cannot read files at run time, so src/lib/bundled-files.ts imports the GeoJSON as data.
  webpack: (config) => {
    config.module.rules.push({ test: /\.geojson$/, type: "json" });
    return config;
  },
};

export default nextConfig;
