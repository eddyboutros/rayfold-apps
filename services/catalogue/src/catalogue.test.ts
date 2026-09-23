import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { createServer, type Server } from "node:http";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { pdf } from "../../../e2e/pdf.ts";
import { startStandInConsole, type StandInConsole } from "../../../e2e/stand-in-console.ts";
import { until } from "../../../e2e/wait.ts";
import { SEEDED } from "./seed.ts";
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
let bytes: Server & { serve: (path: string, type: string, body: Uint8Array) => string };

beforeAll(async () => {
  platform = await startStandInConsole();
  const files = new Map<string, { type: string; body: Uint8Array }>();
  const server = createServer((req, res) => {
    const file = files.get(req.url ?? "");
    if (!file) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": file.type }).end(file.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  bytes = Object.assign(server, {
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
  await clean();
});
afterAll(async () => {
  await svc?.stop();
  await platform?.stop();
  await new Promise<void>((r) => bytes?.close(() => r()));
});

/** Everything a test here writes: articles under one title, and the files the workers index. */
async function clean(): Promise<void> {
  await svc.sql.query("delete from articles where slug like 'sandbox-reset-how-it-works%'"); // its revisions go with it
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

  const kinds = new Set(page.items.map((h) => h.$type));
  expect(kinds).toEqual(new Set(["Product", "Article"]));
  // the tax engine and the two articles about rounding; the best match first
  expect(page.items[0]).toMatchObject({ $type: "Article", slug: "tax-rounding-policy" });
  for (const hit of page.items) {
    if (hit.$type === "Product") expect(hit).toMatchObject({ sku: expect.any(String) });
    if (hit.$type === "Article") expect(hit).toMatchObject({ slug: expect.any(String) });
    // a condition for another kind contributes nothing to this one
    expect(hit).not.toHaveProperty("title");
  }
  expect(page.hasMore).toBe(false);
});

it("a person is found by what they do, not only by name", async () => {
  const page = await ada().query<Page<Hit>>("search", { q: "security" }, { shape: "{ items { name ...on Person { title } } }" });
  expect(page.items.map((h) => [h.$type, h.name])).toContainEqual(["Person", "Hannah Weiss"]);
  expect(page.items.find((h) => h.$type === "Person")).toMatchObject({ title: "Security engineer" });
});

it("a search pages by cursor, and the second page continues where the first stopped", async () => {
  const first = await ada().query<Page<Hit>>("search", { q: "order", page: { first: 3 } }, { shape: "{ items { id } total hasMore cursor }" });
  expect(first.items).toHaveLength(3);
  expect(first.hasMore).toBe(true);
  expect(first.total).toBeGreaterThan(3);

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
  const page1 = await ada().query<Page<Hit & { updatedAt: number }>>("items", { page: { first: 12 } }, { shape: "{ items { id name updatedAt } total hasMore }" });
  expect(page1.total).toBe(all);
  expect(page1.items).toHaveLength(12);
  expect(page1.hasMore).toBe(true);
  const dates = page1.items.map((i) => i.updatedAt);
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
  expect(kwame.articles.map((a) => a.slug)).toContain("rollout-playbook");
  expect(kwame.articles).toHaveLength(2);
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
  expect(elena.colleagues.map((c) => c.name).sort()).toEqual(["Ada Lovelace", "Grace Hopper", "Hannah Weiss"]);
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
  expect(found.items[0]?.excerpt).toContain("The mirror must reconcile");

  // the steps as the platform ran them: extract read the text, index kept it, notify is for another service
  const steps = stepsOf(planRun.id);
  expect(steps.map((j) => [j.step, j.state])).toEqual([
    ["extract", "done"],
    ["index", "done"],
    ["notify", "ready"],
  ]);
  expect(steps[0]!.result).toMatchObject({ characters: expect.any(Number), excerpt: expect.stringContaining("Cutover plan") });
  expect((steps[1]!.payload as { results: { extract: { characters: number } } }).results.extract.characters).toBeGreaterThan(50);
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
  expect(got.headers.get("cache-control")).toContain("max-age=60");
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
  expect(big?.data).toMatchObject({ budget: 150 });
  expect((big?.data as { cost: number }).cost).toBeGreaterThan(150);
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
