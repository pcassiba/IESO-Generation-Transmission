import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    env: { OGE_DISABLE_SCHEDULER: "1", TZ: "UTC" },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
