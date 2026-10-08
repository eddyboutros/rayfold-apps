/**
 * The help centre's tests: its components in jsdom, against real Rayfold servers built from the catalogue's and the
 * feedback service's own schemas (src/testing/rayfold.ts). The base is the build's, /help/, so a link is drawn as it
 * is served.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import vite from "./vite.config.ts";

export default mergeConfig(
  vite,
  defineConfig({
    test: {
      environment: "jsdom",
      // vitest serves from "/"; the build serves under /help/, so a link is drawn as a reader sees it
      env: { BASE_URL: "/help/" },
      include: ["src/**/*.spec.{ts,tsx}"],
      // a missed signal fails the spec here instead of hanging the run
      testTimeout: 10_000,
    },
  }),
);
