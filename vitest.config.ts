import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["services/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "e2e/**/*.test.ts"],
    // a service test starts a real server against a real Postgres; that is slower than a unit test and worth it
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // one database, so the suites take it in turns rather than truncating each other's tables
    fileParallelism: false,
  },
});
