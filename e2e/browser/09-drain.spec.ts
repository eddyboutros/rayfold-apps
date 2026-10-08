import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADA, BASE, MODE, api, closeStore, feedLines, named, signIn } from "./fleet.ts";

/**
 * A rolling deploy of the workspace while people have it open: the instance they are on drains (SIGTERM: readiness
 * goes false, open live queries and streams end with a retryable error), the next one starts on the same address, and
 * the page carries on without a reload. Last in the run, because the workspace it leaves running is the one it started.
 *
 * In development the spec takes the workspace over from scripts/dev.mjs: it stops that one and starts its own, with
 * the same configuration, so that it can drain it (e2e/browser/drain-on-message.mjs; a Windows process cannot be sent
 * a signal it can catch). Behind the gateway, `docker compose stop workspace` sends the real SIGTERM.
 */
test.afterAll(closeStore);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 4002;
const started: ChildProcess[] = [];

/** The process listening on the workspace's port in development, by the operating system's own account. */
function listener(port: number): number | null {
  if (process.platform === "win32") {
    const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout;
    const line = out.split("\n").find((l) => new RegExp(`:${port}\\s.*LISTENING`).test(l));
    return line ? Number(line.trim().split(/\s+/).pop()) : null;
  }
  const out = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim();
  return out ? Number(out.split("\n")[0]) : null;
}

const ready = async () => (await fetch(`http://127.0.0.1:${PORT}/rayfold/ready`).catch(() => null))?.status ?? 0;

/** A workspace instance as scripts/dev.mjs starts one, on the same port, that this spec can drain. */
async function startInstance(name: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./e2e/browser/drain-on-message.mjs", join("services", "workspace", "src", "main.ts")], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      PORT: String(PORT),
      SELF_URL: `http://localhost:${PORT}`,
      DATABASE_URL: process.env["FLEET_DATABASE_URL"]!,
      CAPABILITY_SECRET: process.env["CAPABILITY_SECRET"] ?? "a-development-secret-at-least-16",
      OPS_TOKEN: process.env["OPS_TOKEN"] ?? "dev-ops-token",
      SERVICE_VERSION: "dev",
      APP_ENVIRONMENT: "development",
      EXPLORER: "1",
      INSTANCE: name,
      CONSOLE_URL: process.env["FLEET_CONSOLE_URL"] ?? "",
      CONSOLE_TOKEN: process.env["FLEET_CONSOLE_TOKEN"] ?? "",
    },
  });
  started.push(child);
  await expect.poll(ready, { timeout: 60_000 }).toBe(200);
  return child;
}

test.afterAll(() => {
  for (const c of started) if (c.exitCode === null) c.kill();
});

/**
 * Whether the workspace panel's client reopens a live query on its own after its instance went away: the client the
 * panel is built with exports `@rayfold/client/testing`, which came with that fix, and 0.2.1 has neither.
 */
const RECOVERS = "./testing" in ((JSON.parse(readFileSync(join(root, "web", "workspace-ui", "node_modules", "@rayfold", "client", "package.json"), "utf8")) as { exports?: Record<string, unknown> }).exports ?? {});

const feed = (page: Page) => page.locator("section.slot", { has: page.locator("h2", { hasText: "Activity" }) });
const chat = (page: Page) => page.locator("section.slot", { has: page.locator("h2", { hasText: "Chat" }) });

test("the workspace drains under an open page, the next instance takes over, and the page carries on", async ({ page }) => {
  test.setTimeout(240_000);
  let drain: () => Promise<void>;
  let next: () => Promise<void>;
  if (MODE === "dev") {
    test.skip(!process.env["FLEET_DATABASE_URL"], "needs the fleet's database to start a workspace of its own");
    const theirs = listener(PORT);
    if (theirs) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(theirs), "/F"], { stdio: "ignore" });
      else process.kill(theirs, "SIGTERM");
    }
    await expect.poll(ready, { timeout: 30_000 }).toBe(0);
    const first = await startInstance("workspace-leaving");
    drain = async () => {
      first.send("drain");
      await new Promise<void>((resolve) => (first.exitCode !== null ? resolve() : first.once("exit", () => resolve())));
    };
    next = async () => void (await startInstance("workspace-next"));
  } else {
    const compose = (...args: string[]) => {
      const run = spawnSync("docker", ["compose", ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });
      if (run.status !== 0) throw new Error(`docker compose ${args.join(" ")}: ${run.stderr}`);
    };
    drain = async () => compose("stop", "workspace");
    next = async () => {
      compose("start", "workspace");
      await expect.poll(async () => (await fetch(`${BASE}/api/workspace/rayfold/ready`).catch(() => null))?.status ?? 0, { timeout: 120_000 }).toBe(200);
    };
  }

  await signIn(page, ADA);
  await expect(feed(page).locator("header .pill")).toHaveText("live");
  await expect(chat(page).locator("header .pill")).toHaveText("stream open");
  const before = named("said before the deploy");
  await api("workspace", ADA).command("say", { projectId: "p1", body: before }, { shape: "{ id }" });
  await expect(chat(page).locator("li.line .text", { hasText: before })).toHaveCount(1);

  await drain();
  // the instance said it was going: the chat's stream ended and says so, with the way back
  await expect(chat(page).locator("header .pill")).toHaveText("stream closed");
  await expect(chat(page).locator("[role=alert]")).toContainText("The stream ended:");

  await next();
  if (!RECOVERS) {
    // @rayfold/client 0.2.1: the feed's live query stops for good once its socket is refused while no instance is up,
    // and the page says so; a reload is the way back. Fixed after 0.2.1 (CHANGELOG, Unreleased: "Live queries recover
    // in both clients", "The TypeScript WebSocket transport connects again after a refused connection")
    await expect(feed(page).locator("header .pill")).toHaveText("disconnected");
    await expect(feed(page).locator(".empty strong")).toHaveText("The feed stopped");
    await page.reload();
    await expect(page.locator(".rail .who strong")).toHaveText(ADA.name);
    await expect(chat(page).locator("li.line .text", { hasText: before })).toHaveCount(1);
  }
  // the feed's live query reopens on its own through the same address: a line made now arrives without a reload
  const title = named("Opened after the deploy");
  await api("workspace", ADA).command("createIssue", { projectId: "p1", title }, { shape: "{ id }" });
  await expect.poll(() => feedLines(page, title), { timeout: 60_000 }).toEqual([`Ada Lovelace | opened | ${title}`]);
  await expect(feed(page).locator("header .pill")).toHaveText("live");
  // and the chat comes back when asked to, hearing what is said next
  if (RECOVERS) await chat(page).getByRole("button", { name: "Reconnect" }).click();
  await expect(chat(page).locator("header .pill")).toHaveText("stream open");
  const after = named("said after the deploy");
  await api("workspace", ADA).command("say", { projectId: "p1", body: after }, { shape: "{ id }" });
  await expect(chat(page).locator("li.line .text", { hasText: after })).toHaveCount(1);
});
