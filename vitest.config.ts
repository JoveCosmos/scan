import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Pure logic only — no jsdom, so the suite stays fast enough to gate builds.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
