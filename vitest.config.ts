import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Pure logic only - no jsdom, so the suite stays fast enough to gate builds.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  // Components compile with the automatic JSX runtime, as Next builds them,
  // so a server-rendered component can be tested without importing React.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
