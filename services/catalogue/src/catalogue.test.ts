import { afterAll, beforeAll, expect, it } from "vitest";
import type { RayfoldClientError } from "@rayfold/client";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { SEEDED } from "./seed.ts";

/**
 * The catalogue as it runs. What is asserted is what the schema promises: one search across three kinds of thing,
 * each shaped by `...on`; one list of an interface in numbered pages; a lazy field that is not on a list; an edit
 * that cannot land on someone else's.
 */
let svc: TestService;

beforeAll(async () => {
  svc = await startTestService("catalogue");
  // the catalogue is reference data and is not emptied between runs, so what a test writes it removes itself
  await svc.sql.query("delete from articles where slug like 'sandbox-reset-how-it-works%'");
});
afterAll(() => svc?.stop());

const ada = () => svc.client("ada");

interface Hit {
  $type: "Product" | "Person" | "Article";
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
  const seen = new Set(first.items.map((h) => h.id));
  expect(second.items.some((h) => seen.has(h.id))).toBe(false);

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
