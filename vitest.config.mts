import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Load .geojson as JSON, like the webpack rule in next.config.ts (src/lib/bundled-files.ts imports them).
  plugins: [{ name: "geojson-as-json", transform: (code, id) => (id.endsWith(".geojson") ? { code: `export default ${code};`, map: null } : undefined) }],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    env: { OGE_DISABLE_SCHEDULER: "1", TZ: "UTC" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
