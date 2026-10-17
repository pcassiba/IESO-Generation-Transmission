import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a WASM Postgres build and `pg` has optional native bindings: keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  devIndicators: false,
};

export default nextConfig;
