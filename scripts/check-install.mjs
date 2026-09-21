#!/usr/bin/env node
/**
 * Checks the native bindings npm drops on the floor.
 *
 * npm has a long-standing bug with optional dependencies (npm/cli#4828): installing into an existing tree can leave
 * out the platform binary a package needs, and the only symptom is a stack trace from deep inside the tool that
 * needed it. This has cost time in three repositories, so the check is a line of its own and says what fixes it.
 *
 *   node scripts/check-install.mjs
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** What has actually gone missing here, and what needs it. */
const NEEDED = [{ pkg: "rolldown", reason: "vitest cannot start without it" }];

let broken = false;
for (const { pkg, reason } of NEEDED) {
  try {
    const entry = require.resolve(pkg);
    if (!existsSync(entry)) throw new Error("not installed");
    // resolving the package is not enough: the binding is an optional dependency of it, and that is what goes missing
    const { default: manifest } = await import(`${pkg}/package.json`, { with: { type: "json" } });
    const optional = Object.keys(manifest.optionalDependencies ?? {});
    const present = optional.filter((name) => {
      try {
        require.resolve(`${name}/package.json`);
        return true;
      } catch {
        return false;
      }
    });
    if (optional.length && !present.length) {
      console.error(`${pkg}: none of its ${optional.length} platform bindings are installed — ${reason}`);
      broken = true;
    }
  } catch {
    console.error(`${pkg} is not installed — ${reason}`);
    broken = true;
  }
}

if (broken) {
  console.error("\nnpm/cli#4828. one command fixes it:\n\n  rm -rf node_modules package-lock.json && npm install\n");
  process.exit(1);
}
console.log("native bindings are installed");
