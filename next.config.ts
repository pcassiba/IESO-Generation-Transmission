import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a WASM Postgres build and `pg` has optional native bindings: keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  devIndicators: false,
  // The API reads facility metadata and the transmission network from disk; ship them with the serverless functions.
  outputFileTracingIncludes: {
    "/api/**": ["./data/facilities/*.json", "./data/transmission/*.json", "./public/geo/*.geojson"],
  },
};

export default nextConfig;
