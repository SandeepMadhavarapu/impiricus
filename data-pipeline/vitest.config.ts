import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@pipeline": path.resolve(__dirname, "./src") } },
  test: {
    environment: "node",
    // Live smoke checks are opt-in: excluded from the default run so the suite
    // never depends on repeated network calls, included when LIVE=1.
    include: ["tests/**/*.test.ts"],
    exclude:
      process.env.LIVE === "1"
        ? ["node_modules/**"]
        : ["tests/live.smoke.test.ts", "node_modules/**"],
  },
});
