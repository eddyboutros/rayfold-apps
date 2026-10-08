/**
 * What every browser spec needs: where the fleet is, who to sign in as, and a way to ask a service what it stored.
 *
 * A service is asked through the same paths the browser uses (`/api/<service>/rayfold`), so the dev servers' proxies
 * and the gateway are on the path of every check, as they are on every click.
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import pg from "pg";

export const BASE = (process.env["FLEET_URL"] ?? "http://localhost:4200").replace(/\/$/, "");
/** `dev`: started by run.mjs from scripts/dev.mjs and scripts/web.mjs. `compose`: behind the gateway, as deployed. */
export const MODE = (process.env["FLEET_MODE"] ?? "dev") as "dev" | "compose";
export const WITH_JVM = !process.env["FLEET_NO_JVM"];
/** Whether files kept become searchable: there is a console (the stand-in one) for the flow to run on. */
export const WITH_CONSOLE = !!process.env["FLEET_CONSOLE_URL"];

/** Names made unique to this run, so a fleet that already holds data is not a problem and nothing collides. */
export const RUN = Date.now().toString(36);
export const named = (what: string) => `${what} ${RUN}`;

export interface Person {
  handle: string;
  id: string;
  name: string;
}
export const ADA: Person = { handle: "ada", id: "u1", name: "Ada Lovelace" };
export const GRACE: Person = { handle: "grace", id: "u2", name: "Grace Hopper" };
export const NOOR: Person = { handle: "noor", id: "u3", name: "Noor Haddad" };
export const TOMAS: Person = { handle: "tomas", id: "u4", name: "Tomás Ferreira" };

/** A program speaking for someone, as the tests and the CLI clients do: a bearer with their handle. */
export function api(service: string, who: Person | null): RayfoldClient {
  return new RayfoldClient({
    transport: createFetchTransport({
      url: `${BASE}/api/${service}/rayfold`,
      headers: () => (who ? { authorization: `Bearer ${who.handle}` } : {}),
    }),
  });
}

/** JSON with every object's keys in order: the same arguments are the same URL. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

/**
 * A query as the page's own browser would send it, with whatever session cookie its context holds: a GET by URL on
 * the same path the panels use. Answers the data, or throws the error the service answered with.
 */
export async function asBrowser<T>(page: Page, service: string, op: string, args: Record<string, unknown>, shape?: string): Promise<T> {
  const params = new URLSearchParams();
  if (Object.keys(args).length) params.set("a", Buffer.from(canonical(args)).toString("base64url"));
  if (shape) params.set("s", shape);
  const res = await page.request.get(`${BASE}/api/${service}/rayfold/${op}?${params}`, { headers: { accept: "application/rayfold-frames+json" } });
  const frames = (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { data?: T; error?: { code: string; message: string } });
  const answer = frames.find((f) => "data" in f || "error" in f);
  if (!answer) throw new Error(`${op}: no answer (${res.status})`);
  if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
  return answer.data as T;
}

/** What a person reads in an element: its text, whitespace collapsed as a browser lays it out. */
export const reads = (l: Locator): Promise<string> => l.evaluate((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());

/**
 * The project's activity feed as a person reads it, newest first, only the lines about `about`: who, what they did,
 * to what, anything more, and the service it came from when that is not the workspace, joined with " | ".
 */
export async function feedLines(page: Page, about: string): Promise<string[]> {
  const feed = page.locator("section.slot", { has: page.locator("h2", { hasText: "Activity" }) });
  return feed.locator("li.row", { hasText: about }).evaluateAll((rows) =>
    rows.map((r) => [".who", ".verb", ".text", ".more", ".source"].map((s) => r.querySelector(s)?.textContent?.trim()).filter((x) => x).join(" | ")),
  );
}

/** Signs in on the shell's own sign-in page, which sets the session cookie; waits for the rail to say who. */
export async function signIn(page: Page, who: Person): Promise<void> {
  // whoever was signed in before, as a person signing out first would leave it: no session cookie
  const jar = page.context();
  const others = (await jar.cookies(BASE)).filter((c) => c.name !== "keel_session");
  await jar.clearCookies();
  if (others.length) await jar.addCookies(others);
  await page.goto(`${BASE}/`);
  await page.locator("button.person", { hasText: who.name }).click();
  await expect(page.locator(".rail .who strong")).toHaveText(who.name);
}

/** A second person, in a browser of their own: a separate context, so a separate cookie jar. */
export async function asSomeoneElse(browser: Browser, who: Person): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

/** The value of the session cookie the shell set, which is what every service reads. */
export async function session(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(BASE)).find((c) => c.name === "keel_session")?.value;
}

/** The console the fleet is on (the stand-in one run.mjs starts): its flow runs and jobs, as an operator reads them. */
export function platform(): RayfoldClient {
  const url = process.env["FLEET_CONSOLE_URL"];
  if (!url) throw new Error("FLEET_CONSOLE_URL is not set: there is no console to ask");
  return new RayfoldClient({ transport: createFetchTransport({ url: `${url}/rayfold`, headers: () => ({ authorization: `Bearer ${process.env["FLEET_CONSOLE_TOKEN"] ?? ""}` }) }) });
}

let pool: pg.Pool | null = null;
/** What a service stored, read from its own tables in the fleet's database (FLEET_DATABASE_URL; run.mjs sets it). */
export async function stored<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const url = process.env["FLEET_DATABASE_URL"];
  if (!url) throw new Error("FLEET_DATABASE_URL is not set: the specs read what the services stored from their database");
  pool ??= new pg.Pool({ connectionString: url, max: 2 });
  return (await pool.query(sql, params)).rows as T[];
}

export async function closeStore(): Promise<void> {
  await pool?.end();
  pool = null;
}

/** Bounded polling for a server-side condition; fails with what it waited for. */
export async function until<T>(what: string, check: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`still waiting for ${what} after ${ms}ms${last ? `; last error: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
