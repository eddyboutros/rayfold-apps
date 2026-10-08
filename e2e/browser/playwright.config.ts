/**
 * The fleet in a real browser: every cross-service flow a person on the team (or a customer on the help centre) can
 * take, through the real front ends, against the real services, with the real CLI clients beside them.
 *
 *   npm run test:fleet                              # starts the fleet the way a developer does, runs this, stops it all
 *   FLEET_URL=http://localhost:8080 npm run test:fleet    # against a fleet already up, e.g. `docker compose up`
 *
 * `npm run test:fleet` is e2e/browser/run.mjs: it needs Postgres from `npm run db`, a JDK 21 for the Kotlin service
 * (FLEET_NO_JVM=1 runs without it, and skips what needs it), and Chromium for Playwright (`npx playwright install
 * chromium` once). Behind a gateway (FLEET_URL without run.mjs starting anything), set FLEET_MODE=compose, and
 * FLEET_DATABASE_URL to the compose Postgres for the checks that read what a service stored.
 *
 * One fleet, whose data the specs change, so one worker and the files in order; each spec names what it makes with a
 * run id, so a fleet that already has data in it is fine.
 */
import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  // traces of a failure go outside the repository, which keeps nothing a run leaves behind
  outputDir: join(tmpdir(), "rayfold-apps-fleet-results"),
  use: {
    baseURL: process.env["FLEET_URL"] ?? "http://localhost:4200",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  // a desk, not a laptop: the four panels side by side with room for every row's actions
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1680, height: 1050 } } }],
});
