import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { backends, listenersSince, liveClosed, startTestService, type TestService } from "../../../e2e/harness.ts";
import { signal, until } from "../../../e2e/wait.ts";
import { VISITOR_COOKIE } from "./visitor.ts";

/**
 * The feedback service as it runs: Hono on Node in front of Rayfold's fetch handler, a real Postgres, the real
 * client. What is asserted is what the help centre and the writers rely on: a visitor is known again by a cookie this
 * service sets, a visitor answers a page once, a visitor reads only their own answers while the team reads them all
 * (and the list's total agrees), and a member watching a page hears each answer as it is given.
 */
let svc: TestService;

beforeAll(async () => {
  svc = await startTestService("feedback", { EXPLORER: "1" });
});
afterAll(async () => {
  await svc?.stop();
});
beforeEach(async () => {
  await svc.reset();
});
afterEach(() => liveClosed(svc));

const SLUG = "exporting-invoices";

/** A visitor the service has already met: the browser sends back the cookie it was given. */
const visitor = () => {
  const id = crypto.randomUUID();
  const client = new RayfoldClient({ transport: createFetchTransport({ url: `${svc.base}/rayfold`, headers: () => ({ cookie: `${VISITOR_COOKIE}=${id}` }) }) });
  return Object.assign(client, { visitorId: id });
};
const member = (who: string) => svc.client(who);

interface Rating {
  id: string;
  slug: string;
  visitorId: string;
  helpful: boolean;
  comment: string | null;
  at: string;
}
interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
}
const RATING = "{ id slug visitorId helpful comment at }";

it("a first visit is given a cookie that names it, and the answer it gave is that visitor's from then on", async () => {
  // the browser's first request: no cookie, so the middleware makes a visitor and says so on the way out
  const res = await fetch(`${svc.base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ id: 1, op: "rate", args: { slug: SLUG, helpful: true }, shape: RATING, key: crypto.randomUUID() }] }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const cookie = res.headers.get("set-cookie") ?? "";
  const [, id] = /^keel_visitor=([0-9a-f-]{36});/.exec(cookie) ?? [];
  // a year, on the whole origin, out of a script's reach
  expect(cookie).toBe(`keel_visitor=${id}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`);
  const [frame] = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { ok: Rating });
  expect(frame!.ok).toMatchObject({ slug: SLUG, visitorId: id, helpful: true });

  // the next request carries the cookie, and is the same visitor: their answer is theirs
  const again = await fetch(`${svc.base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${VISITOR_COOKIE}=${id}` },
    body: JSON.stringify({ ops: [{ id: 1, op: "ratings", args: { slug: SLUG }, shape: `{ items ${RATING} total }` }] }),
  });
  expect(again.status).toBe(200);
  // guard: a visitor already known is not given a second identity
  expect(again.headers.get("set-cookie")).toBeNull();
  const [mine] = (await again.text()).trim().split("\n").map((l) => JSON.parse(l) as { data: Page<Rating> });
  expect(mine!.data.total).toBe(1);
  expect(mine!.data.items.map((r) => r.visitorId)).toEqual([id]);

  // and a machine asking whether the service is ready is nobody, and gets no cookie
  const ready = await fetch(`${svc.base}/rayfold/ready`);
  expect(ready.status).toBe(200);
  expect(ready.headers.get("set-cookie")).toBeNull();
});

it("one answer per visitor per page: answering again changes it, and the score counts visitors, not clicks", async () => {
  const a = visitor();
  const b = visitor();
  const first = await a.command<Rating>("rate", { slug: SLUG, helpful: true }, { shape: RATING });
  const changed = await a.command<Rating>("rate", { slug: SLUG, helpful: false, comment: "  The CSV columns are not listed.  " }, { shape: RATING });
  // the same row, changed in place, with what was said trimmed
  expect(changed).toMatchObject({ id: first.id, helpful: false, comment: "The CSV columns are not listed." });
  expect(Date.parse(changed.at)).toBeGreaterThanOrEqual(Date.parse(first.at));
  await b.command("rate", { slug: SLUG, helpful: true }, { shape: "{ id }" });
  // another page's answers are another page's
  await b.command("rate", { slug: "getting-started", helpful: false }, { shape: "{ id }" });

  expect(await a.query("score", { slug: SLUG }, { shape: "{ id helpful unhelpful }" })).toEqual({ $type: "Score", id: SLUG, helpful: 1, unhelpful: 1 });
  expect(await a.query("score", { slug: "getting-started" }, { shape: "{ helpful unhelpful }" })).toEqual({ $type: "Score", helpful: 0, unhelpful: 1 });
  // a page nobody has answered on is a score of nothing, not a missing page
  expect(await a.query("score", { slug: "nobody-read-this" }, { shape: "{ id helpful unhelpful }" })).toEqual({ $type: "Score", id: "nobody-read-this", helpful: 0, unhelpful: 0 });
  const { rows } = await svc.sql.query("select count(*)::int as n from ratings where slug = $1", [SLUG]);
  expect(rows[0]?.["n"]).toBe(2);

  // a retry of one answer, with its key, is the first answer replayed: it does not run again after a later change
  const key = crypto.randomUUID();
  await a.command("rate", { slug: SLUG, helpful: true }, { shape: RATING, key });
  await a.command("rate", { slug: SLUG, helpful: false }, { shape: RATING });
  const replayed = await a.command<Rating>("rate", { slug: SLUG, helpful: true }, { shape: RATING, key });
  // the first answer, as it was given; the later change stands
  expect(replayed.helpful).toBe(true);
  expect(await a.query("score", { slug: SLUG }, { shape: "{ helpful unhelpful }" })).toMatchObject({ helpful: 1, unhelpful: 1 });
});

it("a visitor reads only their own answers and a member reads everyone's: the rule is in the WHERE, so a page and its total hold only what the reader may see", async () => {
  const [a, b, c] = [visitor(), visitor(), visitor()];
  for (const [v, helpful] of [[a, true], [b, false], [c, true]] as const) await v.command("rate", { slug: SLUG, helpful, comment: helpful ? null : "Too short." }, { shape: "{ id }" });

  const own = await b.query<Page<Rating>>("ratings", { slug: SLUG }, { shape: `{ items ${RATING} total hasMore }` });
  expect(own.total).toBe(1);
  expect(own.hasMore).toBe(false);
  expect(own.items.map((r) => [r.visitorId, r.helpful, r.comment])).toEqual([[b.visitorId, false, "Too short."]]);

  // the team reads them all, newest first, a page at a time; the second page continues where the first stopped
  const all = await member("noor").query<Page<Rating>>("ratings", { slug: SLUG, page: { first: 2 } }, { shape: `{ items ${RATING} total hasMore cursor }` });
  expect(all.total).toBe(3);
  expect(all.hasMore).toBe(true);
  expect(all.items.map((r) => r.visitorId)).toEqual([c.visitorId, b.visitorId]);
  const rest = await member("noor").query<Page<Rating>>("ratings", { slug: SLUG, page: { first: 2, after: all.cursor } }, { shape: `{ items { visitorId } total hasMore }` });
  expect(rest.items.map((r) => r.visitorId)).toEqual([a.visitorId]);
  expect(rest.hasMore).toBe(false);

  // guard: someone new is made a visitor on their first batch, and that visitor has no answers to read yet
  const newcomer = new RayfoldClient({ transport: createFetchTransport({ url: `${svc.base}/rayfold` }) });
  expect(await newcomer.query("ratings", { slug: SLUG }, { shape: "{ items { id } total }" })).toEqual({ items: [], total: 0 });
  // and a request that is nobody at all, a GET with neither cookie, the way a shared cache would ask, is refused
  const anonymous = await fetch(`${svc.base}/rayfold/ratings?a=${Buffer.from(JSON.stringify({ slug: SLUG })).toString("base64url")}&s=${encodeURIComponent("{ total }")}`);
  expect(anonymous.headers.get("set-cookie")).toBeNull();
  expect(JSON.parse(await anonymous.text())).toMatchObject({ error: { code: "unauthenticated" } });
});

it("a member watching a page hears every answer as it is given, on a response the fetch runtime keeps open", async () => {
  const seen = signal<{ helpful: number; unhelpful: number }>();
  const stop = member("noor").live<{ helpful: number; unhelpful: number }>("score", { slug: SLUG }, { shape: "{ id helpful unhelpful }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect(await seen.wait("the score's first answer")).toMatchObject({ helpful: 0, unhelpful: 0 });
    await visitor().command("rate", { slug: SLUG, helpful: true }, { shape: "{ id }" });
    expect(await seen.wait("the watcher to hear the first answer")).toMatchObject({ helpful: 1, unhelpful: 0 });
    await visitor().command("rate", { slug: SLUG, helpful: false }, { shape: "{ id }" });
    expect(await seen.wait("the watcher to hear the second")).toMatchObject({ helpful: 1, unhelpful: 1 });
  } finally {
    stop();
  }
});

it("is one of the fleet on the fetch runtime: it says who it is behind the ops token, and serves the explorer when told to", async () => {
  const stats = await fetch(`${svc.base}/rayfold/stats`, { headers: { authorization: `Bearer ${svc.opsToken}` } });
  expect(stats.status).toBe(200);
  expect(((await stats.json()) as { identity: { name: string } }).identity.name).toBe("feedback");
  // guard: the stats are not for anyone without the token
  expect((await fetch(`${svc.base}/rayfold/stats`)).status).toBe(403);

  // EXPLORER=1 here: the page is served, and it talks to the endpoint where a browser reaches it through the gateway
  const explorer = await fetch(`${svc.base}/rayfold/explorer`);
  expect(explorer.status).toBe(200);
  expect(explorer.headers.get("content-type")).toContain("text/html");
  const page = await explorer.text();
  expect(page).toContain('"endpoint":"/api/feedback/rayfold"');
  expect(page).toContain('"title":"Keel: feedback"');
});

it("a cookie that is not one this service hands out is no visitor: a malformed value, or a well-formed one under another name, gets a fresh one", async () => {
  const forged = crypto.randomUUID();
  for (const cookie of [`${VISITOR_COOKIE}=not-a-visitor`, `keel_other=${forged}`]) {
    const res = await fetch(`${svc.base}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ops: [{ id: 1, op: "rate", args: { slug: SLUG, helpful: true }, shape: RATING, key: crypto.randomUUID() }] }),
    });
    const [, fresh] = /^keel_visitor=([0-9a-f-]{36});/.exec(res.headers.get("set-cookie") ?? "") ?? [];
    expect(fresh, cookie).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const [frame] = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { ok: Rating });
    expect(frame!.ok.visitorId, cookie).toBe(fresh);
    expect(frame!.ok.visitorId, cookie).not.toBe(forged);
  }
});

it("answers given in the same instant page apart by id: none lost at the break, and the last page says it is the last", async () => {
  const [a, b, c] = [visitor(), visitor(), visitor()];
  for (const v of [a, b, c]) await v.command("rate", { slug: SLUG, helpful: true }, { shape: "{ id }" });
  await svc.sql.query("update ratings set at = '2026-10-01T09:00:00.000Z' where slug = $1", [SLUG]);
  const { rows } = await svc.sql.query("select visitor_id from ratings where slug = $1 order by id desc", [SLUG]);
  const order = rows.map((r) => r["visitor_id"] as string);
  const noor = member("noor");
  const first = await noor.query<Page<Rating>>("ratings", { slug: SLUG, page: { first: 1 } }, { shape: "{ items { visitorId } hasMore cursor }" });
  const second = await noor.query<Page<Rating>>("ratings", { slug: SLUG, page: { first: 2, after: first.cursor } }, { shape: "{ items { visitorId } hasMore cursor }" });
  expect([first.items.map((r) => r.visitorId), first.hasMore]).toEqual([[order[0]], true]);
  expect([second.items.map((r) => r.visitorId), second.hasMore]).toEqual([[order[1], order[2]], false]);
});

it("a member watching a page's answers hears each one as it is given", async () => {
  const seen = signal<Page<Rating>>();
  const stop = member("noor").live<Page<Rating>>("ratings", { slug: SLUG }, { shape: "{ items { visitorId helpful } total }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the list's first answer")).total).toBe(0);
    const v = visitor();
    await v.command("rate", { slug: SLUG, helpful: false }, { shape: "{ id }" });
    expect((await seen.wait("the list to hear the answer")).items).toEqual([{ $type: "Rating", visitorId: v.visitorId, helpful: false }]);
  } finally {
    stop();
  }
});

it("a page on another origin may not answer for a visitor; the help centre's own origin may, and is told so before it asks", async () => {
  const from = (origin: string) =>
    fetch(`${svc.base}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${VISITOR_COOKIE}=${crypto.randomUUID()}`, origin },
      body: JSON.stringify({ ops: [{ id: 1, op: "rate", args: { slug: SLUG, helpful: true }, shape: "{ id }", key: crypto.randomUUID() }] }),
    });
  const foreign = await from("https://evil.example");
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ status: 403, code: "permission_denied" });
  expect((await svc.sql.query("select 1 from ratings")).rowCount).toBe(0);
  const own = await from("http://localhost:4200");
  expect(own.status).toBe(200);
  await own.text();
  expect((await svc.sql.query("select 1 from ratings")).rowCount).toBe(1);
  const preflight = await fetch(`${svc.base}/rayfold`, { method: "OPTIONS", headers: { origin: "http://localhost:4200", "access-control-request-method": "POST" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:4200");
});

it("an instance says when its database cannot answer, and gives back its connections when it stops", async () => {
  const held: number[] = [];
  const before = await backends(svc.sql);
  const other = await startTestService("feedback", {}, 2);
  try {
    // its relay's connection, its own and nobody else's
    const relays = await listenersSince(svc.sql, before);
    expect(relays).toHaveLength(1);
    held.push(...relays);
    const pool = other.service.deps.sql;
    const query = pool.query.bind(pool);
    pool.query = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof pool.query;
    try {
      expect((await fetch(`${other.base}/rayfold/ready`)).status).toBe(503);
    } finally {
      pool.query = query;
    }
    expect((await fetch(`${other.base}/rayfold/ready`)).status).toBe(200);
  } finally {
    await other.stop();
  }
  // ended, not merely quiet: a relay that let go but kept its connection is still a connection
  await until("its relay connection to be gone", async () => ((await backends(svc.sql)).has(held[0]!) ? undefined : true));
});
