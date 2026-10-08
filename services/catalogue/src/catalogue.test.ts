import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { createServer, type Server } from "node:http";
import { liveClosed, startTestService, type TestService } from "../../../e2e/harness.ts";
import { pdf } from "../../../e2e/pdf.ts";
import { startStandInConsole, type StandInConsole } from "../../../e2e/stand-in-console.ts";
import { signal, until } from "../../../e2e/wait.ts";
import { textOf } from "./extract.ts";
import { PUBLISHED, SEEDED } from "./seed.ts";
import { CatalogueStore } from "./store.ts";

/**
 * The catalogue as it runs. What is asserted is what the schema promises: one search across three kinds of thing,
 * each shaped by `...on`; one list of an interface in numbered pages; a lazy field that is not on a list; an edit
 * that cannot land on someone else's.
 */
let svc: TestService;
/** The platform's queue, as far as this service can tell. */
let platform: StandInConsole;
/** Stands in for the documents service: bytes at a URL, as a job's fetchUrl points at. */
let bytes: Server & { serve: (path: string, type: string, body: Uint8Array) => string; failing: Set<string> };

beforeAll(async () => {
  platform = await startStandInConsole();
  const files = new Map<string, { type: string; body: Uint8Array }>();
  const failing = new Set<string>();
  const server = createServer((req, res) => {
    if (failing.has(req.url ?? "")) return void res.writeHead(500).end("Internal Server Error");
    const file = files.get(req.url ?? "");
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": file.type }).end(file.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  bytes = Object.assign(server, {
    failing,
    serve: (path: string, type: string, body: Uint8Array) => {
      files.set(path, { type, body });
      return `http://127.0.0.1:${port}${path}`;
    },
  });
  svc = await startTestService("catalogue", { CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token, APP_ENVIRONMENT: "test", COST_BUDGET: "150" });
  // what a run that was cut short left behind
  await clean();
});
// the catalogue is reference data and is not emptied between tests, so what a test writes goes after it, whichever
// test runs next
afterEach(async () => {
  vi.restoreAllMocks();
  await liveClosed(svc);
  await clean();
});
afterAll(async () => {
  await svc?.stop();
  await platform?.stop();
  await new Promise<void>((r) => bytes?.close(() => r()));
});

/**
 * Everything a test here writes: every article that is not the seed's (the seed's ids are `ar-`, a written one's is
 * random, and a run cut short may have left one under any slug), and the files the workers index.
 */
async function clean(): Promise<void> {
  await svc.sql.query("delete from articles where id not like 'ar-%'"); // their revisions go with them
  await svc.sql.query("delete from files");
}

const operator = () => new RayfoldClient({ transport: createFetchTransport({ url: `${platform.url}/rayfold`, headers: () => ({ authorization: `Bearer ${platform.token}` }) }) });
/** The documents service's flow, as it defines it: this service works its first two steps. */
const DOCUMENT_KEPT = [
  { name: "extract", queue: "extract-text", lock: "doc:{documentId}" },
  { name: "index", queue: "index-file", after: ["extract"], when: { step: "extract", path: "characters", notEquals: 0 }, lock: "doc:{documentId}" },
  { name: "notify", queue: "notify-workspace", after: ["index"] },
];
const start = async (payload: Record<string, unknown>, key = `${payload["documentId"]}:${payload["version"]}`) => {
  await operator().command("defineFlow", { name: "document-kept", steps: DOCUMENT_KEPT }, { shape: "{ name }", key: crypto.randomUUID() });
  return operator().command<{ id: string }>("startFlow", { name: "document-kept", payload, key }, { shape: "{ id }", key: crypto.randomUUID() });
};
const stepsOf = (runId: string) => platform.jobs.filter((j) => j.flowRun === runId);

const ada = () => svc.client("ada");

interface Hit {
  $type: "Product" | "Person" | "Article" | "File";
  id: string;
  name: string;
  sku?: string;
  title?: string;
  slug?: string;
  summary?: string;
}
interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
}

it("one search finds every kind of thing, and each kind answers with its own fields", async () => {
  const page = await ada().query<Page<Hit>>(
    "search",
    { q: "tax rounding" },
    { shape: "{ items { id name ...on Product { sku } ...on Person { title } ...on Article { slug } } total hasMore }" },
  );

  // the tax engine and the articles that talk about rounding, best match first; each kind with its own field and no
  // other kind's: a condition for another kind contributes nothing to this one
  expect(page).toEqual({
    items: [
      { $type: "Article", id: "ar-tax", name: "Tax rounding policy", slug: "tax-rounding-policy" },
      { $type: "Article", id: "ar-release", name: "Release notes — October", slug: "release-notes-october" },
      { $type: "Product", id: "pr-tax", name: "Tax engine add-on", sku: "OD-TAX" },
      { $type: "Article", id: "ar-northwind", name: "Northwind tenant notes", slug: "northwind-tenant-notes" },
    ],
    total: 4,
    hasMore: false,
  });
});

it("a person is found by what they do, not only by name", async () => {
  const page = await ada().query<Page<Hit>>("search", { q: "security" }, { shape: "{ items { name ...on Person { title } } }" });
  expect(page.items).toEqual([
    { $type: "Article", name: "Access review procedure" },
    { $type: "Person", name: "Hannah Weiss", title: "Security engineer" },
  ]);
});

it("a search pages by cursor, and the second page continues where the first stopped", async () => {
  const first = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 3 } }, { shape: "{ items { id } total hasMore cursor }" });
  expect(first.items).toHaveLength(3);
  expect(first.hasMore).toBe(true);
  expect(first.total).toBe(14);

  const second = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 3, after: first.cursor } }, { shape: "{ items { id } hasMore cursor }" });
  // the next three of the same ranking, not merely three others
  const six = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 6 } }, { shape: "{ items { id } }" });
  expect(six.items).toHaveLength(6);
  expect(first.items.map((h) => h.id)).toEqual(six.items.slice(0, 3).map((h) => h.id));
  expect(second.items.map((h) => h.id)).toEqual(six.items.slice(3, 6).map((h) => h.id));

  // guard: the same page twice is the same page
  const again = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 3 } }, { shape: "{ items { id } }" });
  expect(again.items.map((h) => h.id)).toEqual(first.items.map((h) => h.id));
});

it("leafs through the catalogue in numbered pages, newest first, of one kind or all of them", async () => {
  const all = SEEDED.products + SEEDED.people + SEEDED.articles;
  const page1 = await ada().query<Page<Hit & { updatedAt: string }>>("items", { page: { first: 12 } }, { shape: "{ items { id name updatedAt } total hasMore }" });
  expect(page1.total).toBe(all);
  expect(page1.items).toHaveLength(12);
  expect(page1.hasMore).toBe(true);
  // compared as instants, which is how an RFC 3339 value is ordered
  const dates = page1.items.map((i) => Date.parse(i.updatedAt));
  expect(dates).toEqual([...dates].sort((a, b) => b - a));

  // page 3 of 3, by offset: what "page 3" on a screen sends
  const page3 = await ada().query<Page<Hit>>("items", { page: { first: 12, offset: 24 } }, { shape: "{ items { id } total hasMore }" });
  expect(page3.items).toHaveLength(all - 24);
  expect(page3.hasMore).toBe(false);

  // one kind: only products, and the interface's fields plus the product's own
  const products = await ada().query<Page<Hit>>("items", { kind: "product", page: { first: 50 } }, { shape: "{ items { id name ...on Product { sku } } total }" });
  expect(products.total).toBe(SEEDED.products);
  expect(products.items.every((i) => i.$type === "Product" && typeof i.sku === "string")).toBe(true);
});

it("an article's body is lazy: absent from a list, delivered when a page asks for it", async () => {
  const listed = await ada().query<Page<Hit & { body?: string }>>("items", { kind: "article", page: { first: 3 } }, { shape: "{ items { id name } }" });
  expect(listed.items.every((a) => !("body" in a))).toBe(true);

  const article = await ada().query<{ slug: string; body: string; author: { name: string } }>("article", { slug: "rollout-playbook" }, { shape: "{ slug body author { name } }" });
  expect(article.body).toContain("# Rollout playbook");
  expect(article.author).toMatchObject({ name: "Kwame Mensah" });
});

it("an article is written under a slug made from its title, and an edit needs the version that was read", async () => {
  const written = await ada().command<{ id: string; slug: string; version: number; author: { name: string } }>(
    "writeArticle",
    { name: "Sandbox reset: how it works", summary: "What a reset keeps and what it drops.", body: "# Sandbox reset\n\nEverything but the configuration is dropped.", tags: ["sandbox"] },
    { shape: "{ id slug version author { name } }" },
  );
  expect(written).toMatchObject({ slug: "sandbox-reset-how-it-works", version: 1, author: { name: "Ada Lovelace" } });

  // the same title again is a different page, not a refused one
  const again = await ada().command<{ slug: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "second", tags: [] }, { shape: "{ slug }" });
  expect(again.slug).toBe("sandbox-reset-how-it-works-2");

  const edited = await svc.client("grace").command<{ version: number }>(
    "writeArticle",
    { id: written.id, name: "Sandbox reset: how it works", summary: "What a reset keeps and what it drops.", body: "# Sandbox reset\n\nRevised.", tags: ["sandbox", "platform"] },
    { shape: "{ version }", ifVersion: 1 },
  );
  expect(edited.version).toBe(2);

  // Ada still holds version 1: her edit is refused rather than landing on Grace's
  const stale = await ada()
    .command("writeArticle", { id: written.id, name: "x", summary: "", body: "y", tags: [] }, { shape: "{ version }", ifVersion: 1 })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(stale).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });

  // it is searchable the moment it is written
  const found = await ada().query<Page<Hit>>("search", { q: "sandbox reset" }, { shape: "{ items { ...on Article { slug } } }" });
  expect(found.items.map((h) => h.slug)).toContain("sandbox-reset-how-it-works");

  // what Grace replaced is kept, under the version it was, by the person who wrote it: the body stays lazy on the list
  const listed = await ada().query<Page<{ version: number; name: string; editor: { name: string } | null; body?: string }>>("articleRevisions", { id: written.id }, { shape: "{ items { version name editor { name } } total }" });
  expect(listed.total).toBe(1);
  expect(listed.items[0]).toMatchObject({ version: 1, name: "Sandbox reset: how it works", editor: { name: "Ada Lovelace" } });
  expect("body" in listed.items[0]!).toBe(false);
  const read = await ada().query<Page<{ version: number; body: string }>>("articleRevisions", { id: written.id }, { shape: "{ items { version body } }" });
  expect(read.items[0]).toMatchObject({ version: 1, body: "# Sandbox reset\n\nEverything but the configuration is dropped." });
  // and the article says who wrote what it is now
  expect(await ada().query("article", { slug: "sandbox-reset-how-it-works" }, { shape: "{ version author { name } editor { name } }" })).toMatchObject({ version: 2, author: { name: "Ada Lovelace" }, editor: { name: "Grace Hopper" } });
  // a refused edit keeps no revision (guard)
  expect((await ada().query<Page<unknown>>("articleRevisions", { id: written.id }, { shape: "{ total }" })).total).toBe(1);
});

it("a product knows the rest of its category, and a person their writing and their department, each loaded once for a page", async () => {
  const product = await ada().query<{ name: string; related: Array<{ id: string; name: string }> }>("product", { id: "pr-invoicing" }, { shape: "{ name related { id name } }" });
  expect(product.related.map((p) => p.id)).toEqual(["pr-tax", "pr-returns"]);
  // guard: a category of one has no related products, and never itself
  expect((await ada().query<{ related: unknown[] }>("product", { id: "pr-edi" }, { shape: "{ related { id } }" })).related).toEqual([]);

  const kwame = await ada().query<{ articles: Array<{ slug: string }>; colleagues: Array<{ name: string }> }>("person", { id: "u12" }, { shape: "{ articles { slug } colleagues { name } }" });
  // newest first
  expect(kwame.articles.map((a) => a.slug)).toEqual(["rollout-playbook", "how-we-price-a-migration"]);
  expect(kwame.colleagues.map((c) => c.name)).toEqual(["Priya Raman"]);

  // a whole page of people at once: one read serves every one of them, and each gets their own department. the
  // reads are counted on the store the running service uses, since a read per person gives the same answers
  const departments = vi.spyOn(CatalogueStore.prototype, "peopleInDepartments");
  const writing = vi.spyOn(CatalogueStore.prototype, "articlesBy");
  const page = await ada().query<Page<{ id: string; name: string; department: string; colleagues: Array<{ name: string }> }>>(
    "items",
    { kind: "person", page: { first: 20 } },
    { shape: "{ items { id ...on Person { name department colleagues { name } articles { slug } } } }" },
  );
  expect(page.items).toHaveLength(SEEDED.people);
  const elena = page.items.find((p) => p.name === "Elena Petrova")!;
  expect(elena.colleagues.map((c) => c.name)).toEqual(["Ada Lovelace", "Grace Hopper", "Hannah Weiss"]);
  expect(departments).toHaveBeenCalledTimes(1);
  expect([...departments.mock.calls[0]![0]].sort()).toEqual([...new Set(page.items.map((p) => p.department))].sort());
  expect(writing).toHaveBeenCalledTimes(1);
  expect([...writing.mock.calls[0]![0]].sort()).toEqual(page.items.map((p) => p.id).sort());
});

it("a kept document's text is read by the extract step, indexed by the index step, and found — text and PDF alike", async () => {
  const plan = bytes.serve("/files/r1", "text/markdown", new TextEncoder().encode("# Cutover plan\n\nThe mirror must reconcile for five consecutive days before wave two. The zebra clause applies."));
  const contract = bytes.serve("/files/r2", "application/pdf", pdf("Master services agreement", ["Availability: 99.9% measured monthly, excluding announced maintenance."]));
  const planRun = await start({ documentId: "doc-plan", projectId: "p1", name: "Cutover plan.md", version: 1, contentType: "text/markdown", size: 80, url: "/files/r1", fetchUrl: plan });
  await start({ documentId: "doc-msa", projectId: "p1", name: "Master services agreement.pdf", version: 1, contentType: "application/pdf", size: 900, url: "/files/r2", fetchUrl: contract });

  // the workers are this service's own: nothing is called here but the platform
  const found = await until("the plan to be searchable", async () => {
    // a phrase only the file has: the articles talk about consecutive days too, and rank above a file by design
    const page = await ada().query<Page<Hit & { excerpt?: string; url?: string }>>("search", { q: "zebra clause" }, { shape: "{ items { name ...on File { excerpt url projectId } } }" });
    return page.items.length ? page : undefined;
  });
  expect(found.items[0]).toMatchObject({ $type: "File", name: "Cutover plan.md", url: "/files/r1", projectId: "p1" });
  expect(found.items[0]?.excerpt).toBe("# Cutover plan The mirror must reconcile for five consecutive days before wave two. The zebra clause applies.");

  // the steps as the platform ran them: extract read the text, index kept it, notify is for another service
  const steps = stepsOf(planRun.id);
  expect(steps.map((j) => [j.step, j.state])).toEqual([
    ["extract", "done"],
    ["index", "done"],
    ["notify", "ready"],
  ]);
  const planText = "# Cutover plan\n\nThe mirror must reconcile for five consecutive days before wave two. The zebra clause applies.";
  expect(steps[0]!.result).toEqual({ characters: planText.length, excerpt: planText.replace(/\s+/g, " "), text: planText });
  expect((steps[1]!.payload as { results: { extract: { characters: number } } }).results.extract.characters).toBe(planText.length);
  expect(steps[1]!.result).toEqual({ indexed: true, characters: (steps[0]!.result as { characters: number }).characters });

  // the PDF's text, from its content stream: a phrase inside it, not only its name
  const msa = await until("the pdf to be searchable", async () => {
    const page = await ada().query<Page<Hit>>("search", { q: "announced maintenance" }, { shape: "{ items { name } }" });
    return page.items.length ? page : undefined;
  });
  expect(msa.items.map((h) => h.name)).toContain("Master services agreement.pdf");

  // a newer version replaces the text; an older one that finishes later does not put it back
  const revised = bytes.serve("/files/r3", "text/markdown", new TextEncoder().encode("# Cutover plan, revised\n\nSeven consecutive days now."));
  await start({ documentId: "doc-plan", projectId: "p1", name: "Cutover plan.md", version: 2, contentType: "text/markdown", size: 60, url: "/files/r3", fetchUrl: revised });
  await until("the revision to be indexed", async () => ((await svc.sql.query("select version from files where id = 'doc-plan'")).rows[0]?.["version"] === 2 ? true : undefined));
  // its own key: the first run about version 1 is still open here (nobody works notify in this test), and a start
  // with the same key would rightly hand that run back rather than begin another
  const stale = await start({ documentId: "doc-plan", projectId: "p1", name: "Cutover plan.md", version: 1, contentType: "text/markdown", size: 80, url: "/files/r1", fetchUrl: plan }, "doc-plan:1:again");
  await until("the stale run's index step to be done", async () => (stepsOf(stale.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  expect(stepsOf(stale.id).find((j) => j.step === "index")!.result).toMatchObject({ indexed: false });
  expect((await svc.sql.query("select version, url from files where id = 'doc-plan'")).rows[0]).toMatchObject({ version: 2, url: "/files/r3" });

  // files leaf through with everything else, as their own kind
  const files = await ada().query<Page<Hit>>("items", { kind: "file", page: { first: 10 } }, { shape: "{ items { id name } total }" });
  expect(files.total).toBe(2);
  expect(files.items.every((i) => i.$type === "File")).toBe(true);
});

it("a document that is gone by the time its step runs has nothing to index: the index step is skipped by its condition, not by an if, and what was indexed of it comes out", async () => {
  // indexed first, from a run that found its bytes
  const kept = bytes.serve("/files/gone-v1", "text/plain", new TextEncoder().encode("The quokka clause is struck."));
  const first = await start({ documentId: "doc-gone", projectId: "p1", name: "gone.txt", version: 1, contentType: "text/plain", size: 28, url: "/files/gone-v1", fetchUrl: kept });
  await until("the first version to be indexed", async () => (stepsOf(first.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  const quokka = () => ada().query<Page<Hit>>("search", { q: "quokka" }, { shape: "{ items { id } }" });
  expect((await quokka()).items).toEqual([{ $type: "File", id: "doc-gone" }]);

  // then deleted in the documents service: its next version's bytes are not there
  const run = await start({ documentId: "doc-gone", projectId: "p1", name: "gone.txt", version: 2, contentType: "text/plain", size: 1, url: "/files/none", fetchUrl: bytes.serve("/files/none-here", "text/plain", new Uint8Array()).replace("none-here", "none") });
  await until("the extract step to be done", async () => (stepsOf(run.id).find((j) => j.step === "extract")?.state === "done" ? true : undefined));
  expect((await svc.sql.query("select 1 from files where id = 'doc-gone'")).rowCount).toBe(0);
  expect((await quokka()).items).toEqual([]);
  expect(stepsOf(run.id).map((j) => [j.step, j.state])).toEqual([
    ["extract", "done"],
    ["index", "skipped"],
    ["notify", "ready"], // told, so it can say there was nothing to index
  ]);
  expect(stepsOf(run.id)[0]).toMatchObject({ attempts: 1, result: { characters: 0 } });
});

it("named views: no shape gets the default, a spread gets the card, and the same reads on a REST route with its cache headers", async () => {
  const plain = await ada().query<Record<string, unknown>>("product", { id: "pr-invoicing" });
  expect(Object.keys(plain).sort()).toEqual(["$type", "availability", "id", "name", "price", "sku", "updatedAt"]);
  const card = await ada().query<Record<string, unknown>>("product", { id: "pr-invoicing" }, { shape: "{ ...Product.card }" });
  expect(Object.keys(card).sort()).toEqual(["$type", "availability", "category", "id", "name", "price", "sku", "summary", "updatedAt"]);
  const person = await ada().query<{ articles: Array<{ slug: string }> }>("person", { id: "u12" }, { shape: "{ ...Person.card }" });
  expect(person.articles.map((a) => a.slug)).toContain("rollout-playbook");

  const got = await fetch(`${svc.base}/products/pr-invoicing`, { headers: { authorization: "Bearer ada" } });
  expect(got.status).toBe(200);
  // @cache(maxAge: 60s, scope: public) on the entity is the route's Cache-Control
  // and private, because the request is signed in
  expect(got.headers.get("cache-control")).toBe("private, max-age=60");
  expect(Object.keys((await got.json()) as object).sort()).toEqual(["$type", "availability", "id", "name", "price", "sku", "updatedAt"]);
  expect(await (await fetch(`${svc.base}/products/nope`, { headers: { authorization: "Bearer ada" } })).json()).toBeNull(); // a nullable query's null is an answer

  // POST creates, answers 201 with where it is, and needs its key
  const posted = await fetch(`${svc.base}/articles`, { method: "POST", headers: { authorization: "Bearer ada", "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ name: "Sandbox reset: how it works", summary: "", body: "posted", tags: [] }) });
  expect(posted.status, await posted.clone().text()).toBe(201);
  expect(posted.headers.get("location")).toMatch(/^\/articles\/sandbox-reset-how-it-works/);
  const unkeyed = await fetch(`${svc.base}/articles`, { method: "POST", headers: { authorization: "Bearer ada", "content-type": "application/json" }, body: JSON.stringify({ name: "x", summary: "", body: "y", tags: [] }) });
  expect(unkeyed.status).toBe(400);
  expect(unkeyed.headers.get("content-type")).toContain("application/problem+json");
});

it("a batch over the cost budget is refused before it runs, with the cost and the budget", async () => {
  // the estimate caps a page at a hundred rows, so the budget is set under what one such page costs
  const big = await ada().query("items", { kind: "product", page: { first: 500 } }, { shape: "{ items { id name } }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(big?.code).toBe("resource_exhausted");
  expect(big?.data).toEqual({ cost: 203, budget: 150 });
  // guard: the same page at a size the budget allows
  const allowed = await ada().query<Page<Hit>>("items", { kind: "product", page: { first: 12 } }, { shape: "{ items { id } total }" });
  expect(allowed.total).toBe(SEEDED.products);
  expect(allowed.items).toHaveLength(Math.min(12, SEEDED.products));
});

it("nobody may search, and a search needs a phrase", async () => {
  const nobody = svc.client("mallory");
  const refused = await nobody.query("search", { q: "orders" }, { shape: "{ total }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.code).toBe("unauthenticated");

  // checked before any resolver runs: an empty phrase is invalid_argument, not a search for nothing
  const empty = await ada().query("search", { q: "" }, { shape: "{ total }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(empty?.code).toBe("invalid_argument");
});

it("says who it is", async () => {
  const stats = await fetch(`${svc.base}/rayfold/stats`, { headers: { authorization: `Bearer ${svc.opsToken}` } });
  expect(stats.status).toBe(200);
  expect(((await stats.json()) as { identity: { name: string } }).identity.name).toBe("catalogue");
});

it("serves the explorer only where it is turned on, as npm run dev does, and it reaches the endpoint the way a browser does", async () => {
  // this instance runs as production does, with nothing set: no page, the path is only an unknown operation
  const off = await fetch(`${svc.base}/rayfold/explorer`);
  expect(off.headers.get("content-type")).not.toContain("text/html");
  expect(await off.text()).not.toContain("<html");

  const dev = await startTestService("catalogue", { EXPLORER: "1" }, 3);
  try {
    const on = await fetch(`${dev.base}/rayfold/explorer`);
    expect(on.status).toBe(200);
    expect(on.headers.get("content-type")).toContain("text/html");
    const page = await on.text();
    // through the gateway or the shell's dev server, on the page's own origin, with the session the browser has
    expect(page).toContain('"endpoint":"/api/catalogue/rayfold"');
    expect(page).toContain('"title":"Keel: catalogue"');
  } finally {
    await dev.stop();
  }
});

it("a product's cost is the product team's: anyone else still gets the product, with that one field null and its refusal in the frame", async () => {
  const shape = "{ id name price cost }";
  // Noor is on the product team
  expect(await svc.client("noor").query("product", { id: "pr-core" }, { shape })).toEqual({ $type: "Product", id: "pr-core", name: "Order desk", price: 240000, cost: 67200 });

  // Grace is not: the product still answers, and only the cost is withheld
  expect(await svc.client("grace").query("product", { id: "pr-core" }, { shape })).toEqual({ $type: "Product", id: "pr-core", name: "Order desk", price: 240000, cost: null });

  // what the wire says, beside the null: why it is null, and where
  const res = await fetch(`${svc.base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer grace" },
    body: JSON.stringify({ ops: [{ id: 1, op: "product", args: { id: "pr-core" }, shape }] }),
  });
  const frame = JSON.parse((await res.text()).split("\n")[0]!) as { data: { cost: unknown }; errors?: Array<{ code: string; path: string }> };
  expect(frame.data.cost).toBeNull();
  expect(frame.errors).toEqual([expect.objectContaining({ code: "permission_denied", path: "cost" })]);
  // guard: the one allowed to read it gets no error at all
  const own = await fetch(`${svc.base}/rayfold`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer noor" },
    body: JSON.stringify({ ops: [{ id: 1, op: "product", args: { id: "pr-core" }, shape }] }),
  });
  expect(JSON.parse((await own.text()).split("\n")[0]!)).not.toHaveProperty("errors");
});

// ---- the public help centre: published articles, read by anyone, through a door narrower than the catalogue's

interface HelpPage {
  id: string;
  slug: string;
  name: string;
  summary: string;
  body: string;
  publishedAt: string;
}

/** A visitor to the help centre: no session, no token. */
const anyone = () => new RayfoldClient({ transport: createFetchTransport({ url: `${svc.base}/rayfold` }) });
/** A query by URL, the way a browser or a shared cache asks for one: `a` the arguments, `s` the shape. */
const byUrl = (op: string, args: Record<string, unknown>, shape: string) =>
  `${svc.base}/rayfold/${op}?a=${Buffer.from(JSON.stringify(args)).toString("base64url")}&s=${encodeURIComponent(shape)}`;

it("the help centre lists what is published, A to Z, to anyone: the rule is in the WHERE, so a page and its total hold only published pages", async () => {
  const listed = await anyone().query<Page<HelpPage>>("helpPages", {}, { shape: "{ items { slug name publishedAt } total hasMore }" });
  expect(listed.items.map((p) => p.slug)).toEqual(PUBLISHED);
  expect(listed.total).toBe(PUBLISHED.length);
  expect(listed.hasMore).toBe(false);
  for (const p of listed.items) expect(p.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/);
  // fewer pages than articles: the team's own are not on it, and were never read for it
  expect(PUBLISHED.length).toBeLessThan(SEEDED.articles);

  // a page at a time, by cursor: the second continues where the first stopped
  const first = await anyone().query<Page<HelpPage>>("helpPages", { page: { first: 2 } }, { shape: "{ items { slug } total hasMore cursor }" });
  expect(first.items.map((p) => p.slug)).toEqual(PUBLISHED.slice(0, 2));
  expect(first).toMatchObject({ total: PUBLISHED.length, hasMore: true });
  const next = await anyone().query<Page<HelpPage>>("helpPages", { page: { first: 2, after: first.cursor } }, { shape: "{ items { slug } hasMore }" });
  expect(next.items.map((p) => p.slug)).toEqual(PUBLISHED.slice(2, 4));

  // the team sees the same help centre: it is the public's, whoever is reading
  expect((await ada().query<Page<HelpPage>>("helpPages", {}, { shape: "{ items { slug } }" })).items.map((p) => p.slug)).toEqual(PUBLISHED);
});

it("an article the team keeps to itself is not on the help centre, and its address there is simply not found", async () => {
  const page = await anyone().query<HelpPage | null>("helpPage", { slug: "exporting-invoices" }, { shape: "{ slug name body publishedAt }" });
  expect(page).toMatchObject({ slug: "exporting-invoices", name: "Exporting invoices to your finance system", publishedAt: "2026-09-16T09:30:00.000Z" });
  expect(page?.body).toContain("## Running one by hand");
  // an internal page by its address: nothing there, which says nothing about whether it exists
  expect(await anyone().query("helpPage", { slug: "rollout-playbook" }, { shape: "{ slug }" })).toBeNull();
  // nor through the REST route the same query is bound to
  const rest = await fetch(`${svc.base}/help/exporting-invoices`);
  expect(rest.status).toBe(200);
  expect(await rest.json()).toMatchObject({ slug: "exporting-invoices", publishedAt: "2026-09-16T09:30:00.000Z" });
  expect(await (await fetch(`${svc.base}/help/rollout-playbook`)).json()).toBeNull();

  // guard: the public door does not open the catalogue's own; the article itself is for the team
  const refused = await anyone().query("article", { slug: "exporting-invoices" }, { shape: "{ name }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.code).toBe("unauthenticated");
});

it("publishing puts an article on the help centre and taking it off removes it; publishing twice keeps the first day", async () => {
  const written = await ada().command<{ id: string; slug: string; publishedAt: string | null }>(
    "writeArticle",
    { name: "Sandbox reset: how it works", summary: "What a reset keeps.", body: "# Sandbox reset\n\nConfiguration stays.", tags: ["sandbox"] },
    { shape: "{ id slug publishedAt }" },
  );
  expect(written.publishedAt).toBeNull();
  expect(await anyone().query("helpPage", { slug: written.slug }, { shape: "{ slug }" })).toBeNull();

  const published = await svc.client("noor").command<{ publishedAt: string }>("publishArticle", { id: written.id, published: true }, { shape: "{ publishedAt }" });
  // the moment the column keeps, as an RFC 3339 instant
  const { rows: when } = await svc.sql.query("select published_at from articles where id = $1", [written.id]);
  expect(published.publishedAt).toBe((when[0]!["published_at"] as Date).toISOString());
  expect(await anyone().query("helpPage", { slug: written.slug }, { shape: "{ slug name body publishedAt }" })).toEqual({
    $type: "HelpPage",
    slug: written.slug,
    name: "Sandbox reset: how it works",
    body: "# Sandbox reset\n\nConfiguration stays.",
    publishedAt: published.publishedAt,
  });
  const listed = await anyone().query<Page<HelpPage>>("helpPages", {}, { shape: "{ items { slug } total }" });
  expect(listed.total).toBe(PUBLISHED.length + 1);
  expect(listed.items.map((p) => p.slug)).toEqual([...PUBLISHED, written.slug].sort());

  // a second click: still published, from the same day
  const again = await ada().command<{ publishedAt: string }>("publishArticle", { id: written.id, published: true }, { shape: "{ publishedAt }" });
  expect(again.publishedAt).toBe(published.publishedAt);
  expect((await ada().query<{ publishedAt: string }>("article", { slug: written.slug }, { shape: "{ publishedAt }" })).publishedAt).toBe(published.publishedAt);

  // taken off: gone from the help centre, still in the catalogue
  const off = await ada().command<{ publishedAt: string | null }>("publishArticle", { id: written.id, published: false }, { shape: "{ publishedAt }" });
  expect(off.publishedAt).toBeNull();
  expect(await anyone().query("helpPage", { slug: written.slug }, { shape: "{ slug }" })).toBeNull();
  expect((await anyone().query<Page<HelpPage>>("helpPages", {}, { shape: "{ total }" })).total).toBe(PUBLISHED.length);
  expect(await ada().query("article", { slug: written.slug }, { shape: "{ slug }" })).toMatchObject({ slug: written.slug });

  // guard: only the team publishes; a visitor cannot put anything on the help centre
  const refused = await anyone().command("publishArticle", { id: written.id, published: true }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  // refused by the command's own rule, before anything else is asked of the request
  expect(refused).toMatchObject({ code: "unauthenticated", message: expect.stringMatching(/^Sign in/) });
  const missing = await ada().command("publishArticle", { id: "nope", published: true }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(missing).toMatchObject({ code: "domain", type: "NotFound" });
});

it("a help page read by URL is for any cache in between: public, kept stale while it revalidates, a 304 while nothing changed, and private the moment the reader is signed in", async () => {
  const url = byUrl("helpPages", { page: { first: 50 } }, "{ items { slug name summary } total }");
  const first = await fetch(url);
  expect(first.status).toBe(200);
  // @cache(maxAge: 60s, swr: 10m, scope: public) on HelpPage, and nothing in the answer reads who is asking
  expect(first.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=600");
  const etag = first.headers.get("etag") ?? "";
  expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
  const revalidated = await fetch(url, { headers: { "if-none-match": etag } });
  expect(revalidated.status).toBe(304);
  expect(await revalidated.text()).toBe("");

  // the same request from someone signed in is theirs alone: no shared cache may keep it
  const signedIn = await fetch(url, { headers: { authorization: "Bearer ada" } });
  expect(signedIn.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=600");
  // guard: an article read by the team is never public, because the query that reads it is the team's
  const article = await fetch(byUrl("article", { slug: "exporting-invoices" }, "{ name }"), { headers: { authorization: "Bearer ada" } });
  expect(article.headers.get("cache-control")).toMatch(/^private, /);

  // a change is a new answer: the old tag no longer matches once another page is published
  const written = await ada().command<{ id: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "x", tags: [] }, { shape: "{ id }" });
  await ada().command("publishArticle", { id: written.id, published: true }, { shape: "{ id }" });
  const changed = await fetch(url, { headers: { "if-none-match": etag } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(etag);
});

/** RFC 3339 in UTC with milliseconds: what `Date.prototype.toISOString` writes, and what the schema's Instant is. */
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

it("sends every Instant as RFC 3339 in UTC, and the newest file is still first", async () => {
  // the seed's own days, at 09:30 UTC
  expect((await ada().query<{ updatedAt: string }>("product", { id: "pr-core" }, { shape: "{ updatedAt }" })).updatedAt).toBe("2026-09-18T09:30:00.000Z");
  expect((await ada().query<{ updatedAt: string }>("person", { id: "u5" }, { shape: "{ updatedAt }" })).updatedAt).toBe("2026-08-19T09:30:00.000Z");
  // an article's two Instants come from a bigint and a timestamptz; on the wire they are the same form, and equal here
  expect(await ada().query("article", { slug: "resetting-your-sandbox" }, { shape: "{ updatedAt publishedAt }" })).toEqual({
    $type: "Article",
    updatedAt: "2026-09-11T09:30:00.000Z",
    publishedAt: "2026-09-11T09:30:00.000Z",
  });

  // either side of the moment epoch milliseconds gained a digit: the numbers' own text sorts these the wrong way round
  await svc.sql.query(
    `insert into files (id, name, project_id, content_type, size, url, text, version, updated_at) values
       ('fOld', 'old.txt', 'p1', 'text/plain', 1, '/files/rOld', 'old', 1, 999999999999),
       ('fNew', 'new.txt', 'p1', 'text/plain', 1, '/files/rNew', 'new', 1, 1000000000000)`,
  );
  const files = await ada().query<Page<{ id: string; updatedAt: string }>>("items", { kind: "file", page: { first: 12 } }, { shape: "{ items { id updatedAt } }" });
  expect(files.items.map((f) => [f.id, f.updatedAt])).toEqual([
    ["fNew", "2001-09-09T01:46:40.000Z"],
    ["fOld", "2001-09-09T01:46:39.999Z"],
  ]);
  // guard: newest first as instants, which the numbers written out as text would have got backwards
  expect(Date.parse(files.items[0]!.updatedAt)).toBeGreaterThan(Date.parse(files.items[1]!.updatedAt));
  expect(String(1000000000000) < String(999999999999)).toBe(true);

  // what a command answers is the same form, naming the instant the column keeps; an edit keeps the old one as the revision's
  const written = await ada().command<{ id: string; updatedAt: string }>(
    "writeArticle",
    { name: "Sandbox reset: how it works", summary: "", body: "first", tags: [] },
    { shape: "{ id updatedAt }" },
  );
  expect(written.updatedAt).toMatch(RFC3339_UTC);
  const edited = await ada().command<{ updatedAt: string }>("writeArticle", { id: written.id, name: "Sandbox reset: how it works", summary: "", body: "second", tags: [] }, { shape: "{ updatedAt }", ifVersion: 1 });
  const { rows } = await svc.sql.query("select updated_at from articles where id = $1", [written.id]);
  expect(edited.updatedAt).toBe(new Date(Number(rows[0]!["updated_at"])).toISOString());
  const revisions = await ada().query<Page<{ at: string }>>("articleRevisions", { id: written.id }, { shape: "{ items { at } }" });
  expect(revisions.items.map((r) => r.at)).toEqual([written.updatedAt]);
});

it("a search's cursor counts from where the page began: every page by it is the next slice of the whole ranking", async () => {
  const whole = (await ada().query<Page<Hit>>("search", { q: "order", page: { first: 20 } }, { shape: "{ items { id } total }" })).items.map((h) => h.id);
  expect(whole.length).toBeGreaterThanOrEqual(7);
  const pages: string[][] = [];
  let after: string | null = null;
  for (let i = 0; i < 3; i++) {
    const page: Page<Hit> = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 2, ...(after ? { after } : {}) } }, { shape: "{ items { id } hasMore cursor }" });
    pages.push(page.items.map((h) => h.id));
    expect(page.cursor).toBe(String(2 * (i + 1)));
    after = page.cursor;
  }
  expect(pages).toEqual([whole.slice(0, 2), whole.slice(2, 4), whole.slice(4, 6)]);
});

it("a whole page's loaded fields are each row's own: a product's category, a person's writing, newest first", async () => {
  const products = await ada().query<Page<{ id: string; related: Array<{ id: string }> }>>("items", { kind: "product", page: { first: 20 } }, { shape: "{ items { id ...on Product { related { id } } } }" });
  const related = Object.fromEntries(products.items.map((p) => [p.id, p.related.map((r) => r.id)]));
  expect(related["pr-invoicing"]).toEqual(["pr-tax", "pr-returns"]);
  expect(related["pr-core"]).toEqual(["pr-sandbox", "pr-legacy"]);
  expect(related["pr-edi"]).toEqual([]);

  const people = await ada().query<Page<{ id: string; articles: Array<{ slug: string }>; colleagues: Array<{ name: string }> }>>("items", { kind: "person", page: { first: 20 } }, { shape: "{ items { id ...on Person { articles { slug } colleagues { name } } } }" });
  const { rows } = await svc.sql.query("select author_id, slug from articles order by updated_at desc, id");
  for (const p of people.items) {
    expect(p.articles.map((a) => a.slug), p.id).toEqual(rows.filter((r) => r["author_id"] === p.id).map((r) => r["slug"]));
  }
  expect(people.items.find((p) => p.id === "u12")!.articles).toHaveLength(2);
  // colleagues by name, A to Z, never themselves
  expect(people.items.find((p) => p.id === "u9")!.colleagues.map((c) => c.name)).toEqual(["Ada Lovelace", "Grace Hopper", "Hannah Weiss"]);
});

it("a title becomes a clean slug, a title with nothing to make one from is untitled, and a third use of a title is -3", async () => {
  const slugOfWritten = async (name: string) => (await ada().command<{ slug: string }>("writeArticle", { name, summary: "", body: "x", tags: [] }, { shape: "{ slug }" })).slug;
  expect(await slugOfWritten("  ¿Sandbox reset — how it works?  ")).toBe("sandbox-reset-how-it-works");
  expect(await slugOfWritten("Sandbox reset: how it works")).toBe("sandbox-reset-how-it-works-2");
  expect(await slugOfWritten("Sandbox reset, how it works!")).toBe("sandbox-reset-how-it-works-3");
  expect(await slugOfWritten("!!!")).toBe("untitled");
});

it("an edit's dry run writes nothing, and an article's history pages to its end", async () => {
  const written = await ada().command<{ id: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "v1", tags: [] }, { shape: "{ id }" });
  const dry = await ada().command("writeArticle", { id: written.id, name: "Sandbox reset: how it works", summary: "", body: "v2", tags: [] }, { shape: "{ version body }", ifVersion: 1, simulate: true });
  expect(dry).toEqual({ $type: "Article", version: 2, body: "v2" });
  expect(await ada().query("article", { slug: "sandbox-reset-how-it-works" }, { shape: "{ version body }" })).toEqual({ $type: "Article", version: 1, body: "v1" });
  expect((await ada().query<Page<unknown>>("articleRevisions", { id: written.id }, { shape: "{ total }" })).total).toBe(0);
  for (let v = 1; v <= 3; v++) await ada().command("writeArticle", { id: written.id, name: "Sandbox reset: how it works", summary: "", body: `v${v + 1}`, tags: [] }, { shape: "{ id }", ifVersion: v });
  const pages: number[][] = [];
  const more: boolean[] = [];
  let after: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page: Page<{ version: number; id: string }> = await ada().query<Page<{ version: number; id: string }>>("articleRevisions", { id: written.id, page: { first: 2, ...(after ? { after } : {}) } }, { shape: "{ items { id version } hasMore cursor total }" });
    pages.push(page.items.map((r) => r.version));
    more.push(page.hasMore);
    if (!page.hasMore) break;
    after = page.cursor;
  }
  expect({ pages, more }).toEqual({ pages: [[3, 2], [1]], more: [true, false] });
});

it("an article written before editors were kept was edited by its author", async () => {
  const written = await ada().command<{ id: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "x", tags: [] }, { shape: "{ id }" });
  await svc.sql.query("update articles set editor_id = null where id = $1", [written.id]);
  expect(await svc.client("grace").query("article", { slug: "sandbox-reset-how-it-works" }, { shape: "{ author { name } editor { name } }" })).toEqual({
    $type: "Article",
    author: { $type: "Person", name: "Ada Lovelace" },
    editor: { $type: "Person", name: "Ada Lovelace" },
  });
});

it("an edit that lost the race to another lands nowhere, and keeps no revision", async () => {
  const store = new CatalogueStore(svc.sql);
  const written = await ada().command<{ id: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "x", tags: [] }, { shape: "{ id }" });
  const current = (await store.articleById(written.id))!;
  const lost = { ...current, body: "lost", version: 2 };
  expect(await store.updateArticle(lost, 0, { id: "rev-lost", articleId: current.id, version: 0, name: current.name, summary: "", tags: [], body: "x", editorId: "u1", at: current.updatedAt })).toBe(false);
  expect(await store.articleById(written.id)).toEqual(current);
  expect((await svc.sql.query("select 1 from article_revisions where id = 'rev-lost'")).rowCount).toBe(0);
});

it("bytes the documents service could not serve are retried, not indexed; and an open list of files hears one when it is indexed", async () => {
  const seen = signal<Page<{ id: string }>>();
  const stop = ada().live<Page<{ id: string }>>("items", { kind: "file", page: { first: 10 } }, { shape: "{ items { id } total }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the list's first answer")).items).toEqual([]);
    // a server error is not "gone": the step fails, the queue retries it to its limit, and nothing is indexed
    const broken = bytes.serve("/files/broken", "text/plain", new Uint8Array());
    bytes.failing.add("/files/broken");
    const run = await start({ documentId: "doc-broken", projectId: "p1", name: "broken.txt", version: 1, contentType: "text/plain", size: 5, url: "/files/broken", fetchUrl: broken });
    await until("the extract step to be dead", () => (stepsOf(run.id).find((j) => j.step === "extract")?.state === "dead" ? true : undefined));
    expect(stepsOf(run.id)[0]).toMatchObject({ attempts: 5, error: "fetching the bytes answered 500" });
    expect((await svc.sql.query("select 1 from files where id = 'doc-broken'")).rowCount).toBe(0);

    const fine = bytes.serve("/files/fine", "text/plain", new TextEncoder().encode("The pelican clause."));
    await start({ documentId: "doc-fine", projectId: "p1", name: "fine.txt", version: 1, contentType: "text/plain", size: 19, url: "/files/fine", fetchUrl: fine });
    expect((await seen.wait("the open list to hear the file")).items).toEqual([{ $type: "File", id: "doc-fine" }]);
  } finally {
    stop();
  }
});

it("the same version indexed again is kept again: a retry of a step that already landed is not a stale one", async () => {
  const plan = bytes.serve("/files/again", "text/plain", new TextEncoder().encode("The heron clause."));
  const first = await start({ documentId: "doc-again", projectId: "p1", name: "again.txt", version: 1, contentType: "text/plain", size: 17, url: "/files/again", fetchUrl: plan });
  await until("the first index", () => (stepsOf(first.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  const second = await start({ documentId: "doc-again", projectId: "p1", name: "again.txt", version: 1, contentType: "text/plain", size: 17, url: "/files/again", fetchUrl: plan }, "doc-again:1:retry");
  await until("the second index", () => (stepsOf(second.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  expect(stepsOf(second.id).find((j) => j.step === "index")!.result).toEqual({ indexed: true, characters: 17 });
});

it("a file renamed in the documents service is found by its new name; new bytes are the flow's to bring", async () => {
  for (const [id, words] of [["doc-heron", "The heron clause."], ["doc-crane", "The crane clause."]] as const) {
    const url = bytes.serve(`/files/${id}`, "text/plain", new TextEncoder().encode(words));
    const run = await start({ documentId: id, projectId: "p1", name: `${id}.txt`, version: 1, contentType: "text/plain", size: 17, url: `/files/${id}`, fetchUrl: url });
    await until(`${id}'s index`, () => (stepsOf(run.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  }
  const relay = (documentId: string, payload: Record<string, unknown>) =>
    svc.sql.query("select pg_notify('rayfold', $1)", [JSON.stringify({ from: "documents-test", event: { name: "DocumentChanged", payload: { documentId, projectId: "p1", version: 2, byId: "u1", ...payload } } })]);
  const names = async () => (await svc.sql.query("select id, name, version, text from files order by id")).rows;
  const found = async (q: string) => (await ada().query<Page<{ name: string }>>("search", { q }, { shape: "{ items { name } }" })).items.map((i) => i.name);

  // new bytes, a publisher that does not say, and a rename of a document never indexed: none renames a kept file
  await relay("doc-heron", { name: "heron v2.txt", revision: true });
  await relay("doc-heron", { name: "heron v3.txt" });
  await relay("doc-none", { name: "x.txt", revision: false });
  // the rename sent after them, of the other file: once it has landed, the three before it have been handled
  await relay("doc-crane", { name: "crane final.txt", revision: false });
  await until("the crane's rename", async () => ((await found("crane clause"))[0] === "crane final.txt" ? true : undefined));
  expect(await names()).toEqual([
    { id: "doc-crane", name: "crane final.txt", version: 1, text: "The crane clause." },
    { id: "doc-heron", name: "doc-heron.txt", version: 1, text: "The heron clause." },
  ]);
  // and a rename of this one, found by its new name, its text and version as they were
  await relay("doc-heron", { name: "heron final.txt", version: 4, revision: false });
  await until("the heron's rename", async () => ((await found("heron clause"))[0] === "heron final.txt" ? true : undefined));
  expect((await names())[1]).toEqual({ id: "doc-heron", name: "heron final.txt", version: 1, text: "The heron clause." });
});

it("a file's excerpt is its first two hundred characters, whitespace folded, and says it goes on", async () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join("\n  ");
  const long = bytes.serve("/files/long", "text/plain", new TextEncoder().encode(words));
  const run = await start({ documentId: "doc-long", projectId: "p1", name: "long.txt", version: 1, contentType: "text/plain", size: words.length, url: "/files/long", fetchUrl: long });
  await until("the index", () => (stepsOf(run.id).find((j) => j.step === "index")?.state === "done" ? true : undefined));
  const flat = words.replace(/\s+/g, " ");
  const file = await ada().query<Page<{ excerpt: string }>>("items", { kind: "file", page: { first: 1 } }, { shape: "{ items { ...on File { excerpt } } }" });
  expect(file.items[0]!.excerpt).toBe(`${flat.slice(0, 199).trimEnd()}…`);
  expect(file.items[0]!.excerpt).toHaveLength(200);
});

it("an open help centre hears an article published and taken off", async () => {
  const written = await ada().command<{ id: string; slug: string }>("writeArticle", { name: "Sandbox reset: how it works", summary: "", body: "x", tags: [] }, { shape: "{ id slug }" });
  const seen = signal<Page<{ slug: string }>>();
  const stop = anyone().live<Page<{ slug: string }>>("helpPages", { page: { first: 50 } }, { shape: "{ items { slug } total }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the help centre's first answer")).total).toBe(PUBLISHED.length);
    await ada().command("publishArticle", { id: written.id, published: true }, { shape: "{ id }" });
    expect((await seen.wait("the help centre to hear the publish")).items.map((p) => p.slug)).toEqual([...PUBLISHED, written.slug].sort());
    await ada().command("publishArticle", { id: written.id, published: false }, { shape: "{ id }" });
    expect((await seen.wait("the help centre to hear it taken off")).items.map((p) => p.slug)).toEqual(PUBLISHED);
  } finally {
    stop();
  }
});

describe("the text in a file", () => {
  it("reads text by its type whatever its case and parameters, or by its name, and nothing else", () => {
    const bytes = new TextEncoder().encode("héllo");
    expect(textOf("TEXT/PLAIN; charset=utf-8", "notes", bytes)).toBe("héllo");
    expect(textOf("application/json; charset=utf-8", "data", bytes)).toBe("héllo");
    expect(textOf("application/octet-stream", "notes.MD", bytes)).toBe("héllo");
    expect(textOf("application/octet-stream", "photo.jpg", bytes)).toBe("");
  });

  it("reads a PDF's drawn strings, escapes and arrays included, one line per string", () => {
    const content = String.raw`BT (Line \(one\)\nnext) Tj [(Ki) -20 (ss)] TJ (caf\351 \\ tab\there) ' ET`;
    const raw = new TextEncoder().encode(`%PDF-1.4\nstream\n${content}\nendstream`);
    expect(textOf("application/pdf", "x.pdf", raw)).toBe("Line (one)\nnext\nKiss\ncafé \\ tab\there");
    // guard: by its name alone it is still a PDF
    expect(textOf("application/octet-stream", "x.PDF", raw)).toBe("Line (one)\nnext\nKiss\ncafé \\ tab\there");
  });
});
