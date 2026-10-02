import { defineConfig } from "vitest/config";

/** Optional live run against a real Freshdesk account: `npm run test:live` (see README). */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // Sequential: tests share discovered IDs and should not burst the account's rate limit.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
