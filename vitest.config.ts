import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hermetic by default: every HTTP call is mocked. Live tests live in tests/live and need `npm run test:live`.
    include: ["tests/*.test.ts"],
    environment: "node",
    unstubEnvs: true,
    unstubGlobals: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process wiring only; exercised end-to-end as a real child process in tests/stdio.test.ts,
      // which v8 coverage of the test runner cannot see.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 85 },
    },
  },
});
