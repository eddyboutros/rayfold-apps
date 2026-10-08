#!/usr/bin/env node
/**
 * `npm run test:fleet`: the whole fleet as a developer runs it, driven in a real browser, and stopped afterwards.
 *
 * It starts, in order: a database of its own on the Postgres from `npm run db` (created fresh, dropped at the end), the
 * stand-in console (e2e/browser/console.ts) so files kept become searchable, `scripts/dev.mjs` with that console's
 * address (the five services, the Kotlin one included), and `scripts/web.mjs` (the five front ends). It waits for every
 * service's /rayfold/ready and every dev server, runs the Playwright specs in e2e/browser, and stops everything it
 * started, whatever happened.
 *
 *   npm run test:fleet                          # everything
 *   npm run test:fleet -- --grep "sign-off"     # anything after -- goes to playwright test
 *   FLEET_URL=http://localhost:8080 npm run test:fleet   # a fleet already running, e.g. docker compose up; starts nothing
 *
 * It refuses to start when something already holds the fleet's ports, rather than test someone's running fleet.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const SERVICES = { documents: 4001, workspace: 4002, catalogue: 4003, approvals: 4004, feedback: 4005 };
const WEB = { shell: 4200, "workspace-ui": 4201, "documents-ui": 4202, "catalogue-ui": 4203, help: 4204 };
const POSTGRES = process.env["FLEET_POSTGRES"] ?? "postgres://postgres:rayfold@127.0.0.1:55432";
const DATABASE = "apps_fleet_browser";
const withJvm = !process.env["FLEET_NO_JVM"];

const children = [];
const log = (line) => console.log(`[fleet] ${line}`);

/** Every process started, with its whole tree: on Windows a child under a shell outlives a plain kill. */
function stopAll() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

function start(name, command, argv, env, onLine) {
  const child = spawn(command, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  children.push(child);
  const quiet = !process.env["FLEET_VERBOSE"];
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
        if (!quiet || /error|exited|fail/i.test(line)) process.stdout.write(`[${name}] ${line}\n`);
      }
    });
  }
  return child;
}

const listening = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

/** Polls until the check holds; bounded, and fails with what it waited for. */
async function until(what, check, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`still waiting for ${what} after ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function admin(sql) {
  const client = new pg.Client({ connectionString: `${POSTGRES}/postgres` });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

let code = 1;
let files = null;
let created = false;
try {
  if (process.env["FLEET_URL"]) {
    log(`testing the fleet at ${process.env["FLEET_URL"]}; starting nothing`);
  } else {
    for (const [name, port] of [...Object.entries(SERVICES), ...Object.entries(WEB)]) {
      if (await listening(port)) throw new Error(`port ${port} (${name}) is already in use: stop the fleet that holds it first`);
    }
    await admin(`drop database if exists ${DATABASE} with (force)`);
    await admin(`create database ${DATABASE}`);
    created = true;
    const databaseUrl = `${POSTGRES}/${DATABASE}`;
    // dev.mjs keeps files under the temp directory; a run of its own keeps them apart from a developer's
    files = mkdtempSync(join(tmpdir(), "fleet-browser-"));

    let consoleLine = null;
    start("console", process.execPath, ["--import", "tsx", "e2e/browser/console.ts"], {}, (line) => {
      if (line.startsWith("console ")) consoleLine = line;
    });
    await until("the stand-in console", async () => consoleLine !== null, 30_000);
    const [, consoleUrl, consoleToken] = consoleLine.split(" ");
    log(`stand-in console on ${consoleUrl}`);

    const env = { DATABASE_URL: databaseUrl, CONSOLE_URL: consoleUrl, CONSOLE_TOKEN: consoleToken, TEMP: files, TMP: files, TMPDIR: files };
    start("dev", process.execPath, ["scripts/dev.mjs", ...(withJvm ? [] : ["--no-jvm"])], env);
    start("web", process.execPath, ["scripts/web.mjs"], {});

    const services = Object.entries(SERVICES).filter(([name]) => withJvm || name !== "approvals");
    for (const [name, port] of services) {
      await until(`${name} to be ready on :${port}`, async () => (await fetch(`http://127.0.0.1:${port}/rayfold/ready`)).status === 200, 180_000);
      log(`${name} is ready on :${port}`);
    }
    // the first build of five dev servers takes minutes; each answers once its bundle is built
    await until("the shell's dev server", async () => (await fetch(`http://localhost:${WEB.shell}/`)).status === 200, 600_000);
    for (const remote of ["documents-ui", "workspace-ui", "catalogue-ui"]) {
      await until(`${remote} behind the shell`, async () => (await fetch(`http://localhost:${WEB.shell}/remotes/${remote}/remoteEntry.json`)).status === 200, 600_000);
    }
    await until("the help centre", async () => (await fetch(`http://localhost:${WEB.help}/help/`)).status === 200, 300_000);
    log("every service and front end answers");
    process.env["FLEET_URL"] = `http://localhost:${WEB.shell}`;
    process.env["FLEET_MODE"] = "dev";
    process.env["FLEET_DATABASE_URL"] = databaseUrl;
    process.env["FLEET_CONSOLE_URL"] = consoleUrl;
    process.env["FLEET_CONSOLE_TOKEN"] = consoleToken;
  }

  const run = spawnSync(`npx playwright test -c e2e/browser/playwright.config.ts ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  code = run.status ?? 1;
} catch (e) {
  console.error(`[fleet] ${e instanceof Error ? e.message : String(e)}`);
  code = 1;
} finally {
  stopAll();
  if (created) await admin(`drop database if exists ${DATABASE} with (force)`).catch((e) => console.error(`[fleet] could not drop ${DATABASE}: ${e.message}`));
  if (files) rmSync(files, { recursive: true, force: true });
  log(code === 0 ? "passed; everything it started is stopped" : `failed (${code}); everything it started is stopped`);
}
process.exit(code);
