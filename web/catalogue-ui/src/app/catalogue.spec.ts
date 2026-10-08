import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { RAYFOLD_CLIENT, provideRayfold } from "@rayfold/angular";
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";
import catalogueSchema from "../../../../services/catalogue/src/catalogue.rayfold" with { type: "text" };
import feedbackSchema from "../../../../services/feedback/src/feedback.rayfold" with { type: "text" };
import { TestService, all, button, one, settle, text } from "../testing/rayfold";
import { Catalogue } from "./catalogue";
import { HelpFeedback } from "./help-feedback";

const T = "2026-03-04T12:00:00.000Z";
const NOOR = { id: "u3", name: "Noor Haddad", title: "Product" };
const ADA = { id: "u1", name: "Ada Lovelace", title: "Engineering lead" };

interface Row {
  $type: string;
  id: string;
  [k: string]: unknown;
}

const product = (id: string, name: string, category: string, price: number, availability: string, extra: Partial<Row> = {}): Row => ({
  $type: "Product",
  id,
  name,
  sku: `SKU-${id}`,
  summary: `${name} summary`,
  category,
  price,
  cost: price / 4,
  availability,
  updatedAt: T,
  ...extra,
});

const person = (id: string, name: string, department: string, title = "Engineer"): Row => ({
  $type: "Person",
  id,
  name,
  title,
  department,
  email: `${id}@keel.example`,
  location: "Lisbon",
  updatedAt: T,
});

interface ArticleRow extends Row {
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  authorId: string | null;
  editorId: string | null;
  body: string;
  version: number;
  updatedAt: string;
  publishedAt: string | null;
}

/** The catalogue's tables, as the resolvers below read them; each spec starts from these. */
function tables() {
  const products = [
    product("p1", "Edge Router", "Networking", 120000, "available"),
    product("p2", "Core Switch", "Networking", 90000, "limited"),
    product("p3", "Patch Cable", "Accessories", 1500, "waitlist"),
  ];
  const people = [person("u3", "Noor Haddad", "Product", "Product"), person("u1", "Ada Lovelace", "Engineering"), person("u5", "Lin Wei", "Engineering")];
  const articles: ArticleRow[] = [
    {
      $type: "Article",
      id: "a1",
      slug: "rollout-runbook",
      name: "Rollout runbook",
      summary: "How a rollout goes",
      tags: ["ops", "runbook"],
      authorId: "u3",
      editorId: "u1",
      body: "# Steps\n\nDo **this** first.",
      version: 2,
      updatedAt: T,
      publishedAt: null,
    },
    {
      $type: "Article",
      id: "a2",
      slug: "leave-policy",
      name: "Leave policy",
      summary: "Time off",
      tags: [],
      authorId: null,
      editorId: null,
      body: "Ask.",
      version: 1,
      updatedAt: T,
      publishedAt: "2026-02-01T12:00:00.000Z",
    },
  ];
  const files: Row[] = [
    { $type: "File", id: "f1", name: "plan.pdf", projectId: "p1", contentType: "application/pdf", size: 2048, url: "/files/f1", excerpt: "The plan", version: 1, updatedAt: T },
    { $type: "File", id: "f2", name: "notes", projectId: "p9", contentType: "text/plain", size: 1023, url: "/files/f2", excerpt: "Notes", version: 1, updatedAt: T },
    { $type: "File", id: "f3", name: "scan.png", projectId: "p2", contentType: "image/png", size: 1024, url: "/files/f3", excerpt: "", version: 1, updatedAt: T },
    { $type: "File", id: "f4", name: "sheet.xlsx", projectId: "p2", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 3 * 1024 * 1024, url: "/files/f4", excerpt: "", version: 1, updatedAt: T },
    { $type: "File", id: "f5", name: "blob.bin", projectId: "p2", contentType: "application/octet-stream", size: 5, url: "/files/f5", excerpt: "", version: 1, updatedAt: T },
  ];
  const revisions: Array<{ id: string; articleId: string; version: number; name: string; summary: string; tags: string[]; body: string; editorId: string | null; at: string }> = [{ id: "r1", articleId: "a1", version: 1, name: "Rollout notes", summary: "Old", tags: ["draft"], body: "Old *text*", editorId: "u3", at: "2026-01-10T12:00:00.000Z" }];
  return { products, people, articles, files, revisions };
}

type Tables = ReturnType<typeof tables>;

function catalogueResolvers(db: Tables, fail: { search?: string } = {}): Resolvers {
  const byKind = (kind: string | null): Row[] =>
    kind === "product" ? db.products : kind === "person" ? db.people : kind === "article" ? db.articles : kind === "file" ? db.files : [...db.products, ...db.people, ...db.articles, ...db.files];
  return {
    Query: {
      search: ({ q, page }: { q: string; page: { first: number } }) => {
        if (fail.search) throw new RayfoldError("unavailable", fail.search);
        const hits = byKind(null).reverse().filter((r) => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
        return { items: hits.slice(0, page.first), total: hits.length, hasMore: hits.length > page.first, cursor: null };
      },
      items: ({ kind, page }: { kind?: string | null; page: { first: number; offset?: number | null } }) => {
        const rows = byKind(kind ?? null);
        const offset = page.offset ?? 0;
        const items = rows.slice(offset, offset + page.first);
        return { items, total: rows.length, hasMore: offset + items.length < rows.length, cursor: null };
      },
      product: ({ id }: { id: string }) => db.products.find((p) => p.id === id) ?? null,
      person: ({ id }: { id: string }) => db.people.find((p) => p.id === id) ?? null,
      article: ({ slug }: { slug: string }) => db.articles.find((a) => a.slug === slug) ?? null,
      articleRevisions: ({ id }: { id: string }) => {
        const items = db.revisions.filter((r) => r.articleId === id);
        return { items, total: items.length, hasMore: false, cursor: null };
      },
      helpPages: () => ({ items: [], total: 0, hasMore: false, cursor: null }),
      helpPage: () => null,
    },
    Command: {
      writeArticle: ({ id, name, summary, body, tags }: { id: string; name: string; summary: string; body: string; tags: string[] }, ctx) => {
        const current = db.articles.find((a) => a.id === id);
        if (!current) throw RayfoldError.domain("NotFound", { id }, `No article ${id}`);
        ctx.checkVersion(`Article:${current.id}`, current.version, current);
        db.revisions.unshift({ id: `r${current.version}x`, articleId: id, version: current.version, name: current.name, summary: current.summary, tags: current.tags, body: current.body, editorId: current.editorId, at: current.updatedAt });
        Object.assign(current, { name, summary, body, tags, version: current.version + 1, editorId: (ctx.viewer as { id: string }).id });
        return ok(current);
      },
      publishArticle: ({ id, published }: { id: string; published: boolean }) => {
        const current = db.articles.find((a) => a.id === id);
        if (!current) throw RayfoldError.domain("NotFound", { id }, `No article ${id}`);
        current.publishedAt = published ? "2026-03-05T12:00:00.000Z" : null;
        return ok(current);
      },
    },
    Article: {
      author: (articles: ArticleRow[]) => articles.map((a) => db.people.find((p) => p.id === a.authorId) ?? null),
      editor: (articles: ArticleRow[]) => articles.map((a) => db.people.find((p) => p.id === a.editorId) ?? null),
    },
    ArticleRevision: {
      editor: (revisions: Array<{ editorId: string | null }>) => revisions.map((r) => db.people.find((p) => p.id === r.editorId) ?? null),
    },
    Product: {
      related: (products: Row[]) => products.map((p) => db.products.filter((o) => o["category"] === p["category"] && o.id !== p.id)),
    },
    Person: {
      articles: (people: Row[]) => people.map((p) => db.articles.filter((a) => a.authorId === p.id)),
      colleagues: (people: Row[]) => people.map((p) => db.people.filter((o) => o["department"] === p["department"] && o.id !== p.id)),
    },
  } as Resolvers;
}

interface RatingRow {
  id: string;
  slug: string;
  visitorId: string;
  helpful: boolean;
  comment: string | null;
  at: string;
}

function feedbackResolvers(ratings: RatingRow[], stuck: { score?: Promise<never> } = {}): Resolvers {
  return {
    Query: {
      score: ({ slug }: { slug: string }) => {
        if (stuck.score) return stuck.score;
        const mine = ratings.filter((r) => r.slug === slug);
        return { id: slug, helpful: mine.filter((r) => r.helpful).length, unhelpful: mine.filter((r) => !r.helpful).length };
      },
      ratings: ({ slug, page }: { slug: string; page: { first: number } }) => {
        const mine = ratings.filter((r) => r.slug === slug);
        return { items: mine.slice(0, page.first), total: mine.length, hasMore: mine.length > page.first, cursor: null };
      },
    },
    Command: {
      rate: ({ slug, helpful, comment }: { slug: string; helpful: boolean; comment?: string | null }, ctx) => {
        const rating = { id: `x${ratings.length + 1}`, slug, visitorId: (ctx.viewer as { visitor: string }).visitor, helpful, comment: comment ?? null, at: T };
        ratings.unshift(rating);
        return ok(rating, { patch: [{ inv: [`Score:${slug}`] }, { invOp: ["ratings"] }] });
      },
    },
  } as Resolvers;
}

const SHAPE =
  "{ items { id name updatedAt " +
  "...on Product { sku category price availability summary } " +
  "...on Person { title department location email } " +
  "...on Article { slug summary tags author { name } } " +
  "...on File { projectId contentType size url excerpt } } total hasMore }";

describe("the catalogue page", () => {
  let db: Tables;
  let catalogue: TestService;
  let feedback: TestService;
  let ratings: RatingRow[];
  let fixture: ComponentFixture<Catalogue>;
  let root: HTMLElement;

  async function mount(viewer: unknown = ADA, fail: { search?: string } = {}): Promise<void> {
    catalogue = new TestService(catalogueSchema, catalogueResolvers(db, fail), viewer);
    feedback = new TestService(feedbackSchema, feedbackResolvers(ratings), { member: { id: "u1", name: "Ada Lovelace" } });
    // a factory, not a value: an override of a component the page imports is kept from the first spec that made it
    TestBed.overrideComponent(Catalogue, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => catalogue.client() }] } });
    TestBed.overrideComponent(HelpFeedback, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => feedback.client() }] } });
    fixture = TestBed.createComponent(Catalogue);
    root = fixture.nativeElement as HTMLElement;
    await settle(fixture, catalogue, feedback);
  }

  async function click(el: HTMLElement): Promise<void> {
    el.click();
    await settle(fixture, catalogue, feedback);
  }

  /** Types into the search box and lets the pause pass, on a fake clock. */
  async function search(phrase: string): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const input = one<HTMLInputElement>(root, "input[type=search]");
      const before = catalogue.sent.length;
      input.value = phrase;
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(219);
      await Promise.resolve();
      expect(catalogue.sent.slice(before)).toEqual([]);
      vi.advanceTimersByTime(1);
    } finally {
      vi.useRealTimers();
    }
    await settle(fixture, catalogue, feedback);
  }

  beforeEach(() => {
    db = tables();
    ratings = [];
  });

  afterEach(() => {
    fixture?.destroy();
    catalogue?.close();
    feedback?.close();
    vi.useRealTimers();
  });

  it("opens on an overview that asks for a few of each kind, and draws each kind its own way", async () => {
    await mount();
    expect(catalogue.take()).toEqual([
      { op: "items", args: { kind: "product", page: { first: 4 } }, shape: SHAPE },
      { op: "items", args: { kind: "person", page: { first: 8 } }, shape: SHAPE },
      { op: "items", args: { kind: "article", page: { first: 5 } }, shape: SHAPE },
      { op: "items", args: { kind: "file", page: { first: 5 } }, shape: SHAPE },
    ]);
    expect(all(root, "nav.tabs button")).toEqual(["Overview", "Products 3", "People 3", "Articles 2", "Files 5"]);
    expect(one(root, "nav.tabs button.on").textContent?.trim()).toBe("Overview");
    expect(all(root, ".section-title")).toEqual(["Products 3", "People 3", "Articles 2", "Files 5"]);

    const cards = [...root.querySelectorAll(".card.product")];
    expect(cards.map((c) => text(c))).toEqual([
      "Networking Edge Router Edge Router summary €1,200 Available SKU-p1",
      "Networking Core Switch Core Switch summary €900 Limited SKU-p2",
      "Accessories Patch Cable Patch Cable summary €15 Waitlist SKU-p3",
    ]);
    expect(cards.map((c) => c.querySelector(".pill")?.getAttribute("data-availability"))).toEqual(["available", "limited", "waitlist"]);
    expect(all(root, ".card.person .avatar")).toEqual(["NH", "AL", "LW"]);
    expect(text(root.querySelector(".card.person"))).toBe("NH Noor Haddad Product Product · Lisbon u3@keel.example");
    expect(all(root, ".articles:not(.files) .row")).toEqual(["Rollout runbook How a rollout goes ops runbook Noor Haddad · Mar 4", "Leave policy Time off Mar 4"]);

    const files = [...root.querySelectorAll<HTMLAnchorElement>(".files a.row")];
    expect(files.map((a) => a.getAttribute("href"))).toEqual(["/api/documents/files/f1", "/api/documents/files/f2", "/api/documents/files/f3", "/api/documents/files/f4", "/api/documents/files/f5"]);
    expect(files.map((a) => text(a))).toEqual([
      "PDF plan.pdf The plan Northwind rollout 2 KB · Mar 4",
      "FILE notes Notes p9 1023 B · Mar 4",
      "PNG scan.png Q3 compliance 1 KB · Mar 4",
      "XLSX sheet.xlsx Q3 compliance 3.0 MB · Mar 4",
      "BIN blob.bin Q3 compliance 5 B · Mar 4",
    ]);
    expect(files.map((a) => a.querySelector(".glyph")?.getAttribute("data-kind"))).toEqual(["pdf", "text", "image", "sheet", "other"]);
  });

  it("leafs through one kind in numbered pages, asking for each page by its offset", async () => {
    for (let i = 4; i <= 14; i++) db.products.push(product(`p${i}`, `Item ${i}`, "Bulk", 100 * i, "retired"));
    await mount();
    catalogue.take();

    await click(button(root, "Products 14"));
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "product", page: { first: 12, offset: 0 } }, shape: SHAPE }]);
    expect(root.querySelectorAll(".card.product").length).toBe(12);
    expect(all(root, "nav.pager button")).toEqual(["Previous", "1", "2", "Next"]);
    expect(text(one(root, "nav.pager .count"))).toBe("14 products");
    expect(button(root, "Previous").disabled).toBe(true);
    expect(button(root, "Next").disabled).toBe(false);
    expect(button(root, "1").getAttribute("aria-current")).toBe("page");
    expect(button(root, "2").getAttribute("aria-current")).toBe(null);

    await click(button(root, "Next"));
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "product", page: { first: 12, offset: 12 } }, shape: SHAPE }]);
    expect(all(root, ".card.product h3")).toEqual(["Item 13", "Item 14"]);
    expect(button(root, "Next").disabled).toBe(true);
    expect(button(root, "Previous").disabled).toBe(false);
    expect(button(root, "2").getAttribute("aria-current")).toBe("page");

    await click(button(root, "Next"));
    expect(catalogue.take()).toEqual([]);
    // past either end is no page at all, however it is asked for
    fixture.componentInstance.go(3);
    fixture.componentInstance.go(0);
    await settle(fixture, catalogue, feedback);
    expect(catalogue.take()).toEqual([]);
    expect(button(root, "2").getAttribute("aria-current")).toBe("page");

    // another kind starts from its own first page
    await click(button(root, "People 3"));
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "person", page: { first: 16, offset: 0 } }, shape: SHAPE }]);
    await click(button(root, "Products 14"));
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "product", page: { first: 12, offset: 0 } }, shape: SHAPE }]);
    await click(button(root, "Next"));
    catalogue.take();

    await click(button(root, "1"));
    expect(all(root, ".card.product h3")[0]).toBe("Edge Router");
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "product", page: { first: 12, offset: 0 } }, shape: SHAPE }]);
  });

  it("draws no pager for a kind that fits on one page, and other kinds page by their own size", async () => {
    await mount();
    catalogue.take();
    await click(button(root, "People 3"));
    expect(catalogue.take()).toEqual([{ op: "items", args: { kind: "person", page: { first: 16, offset: 0 } }, shape: SHAPE }]);
    expect(root.querySelector("nav.pager")).toBe(null);
    expect(one(root, "nav.tabs button.on").textContent?.trim()).toBe("People 3");

    await click(button(root, "Overview"));
    expect(root.querySelectorAll("section.section").length).toBe(4);
  });

  it("searches only once the typing pauses, and gathers the hits by kind in the page's order", async () => {
    await mount();
    catalogue.take();
    await search("  p1 ");
    expect(catalogue.take()).toEqual([{ op: "search", args: { q: "p1", page: { first: 20 } }, shape: SHAPE }]);
    // the file comes back first and the product second; the page still puts products before files
    expect(text(one(root, "p.status"))).toBe("2 results for “p1”, best match first");
    expect(all(root, ".section-title")).toEqual(["Products 1", "Files 1"]);
    expect(root.querySelector("p.more")).toBe(null);
    expect(text(one(root, "button.clear"))).toBe("Clear");

    await click(button(root, "Clear"));
    expect(one<HTMLInputElement>(root, "input[type=search]").value).toBe("");
  });

  it("searches once for what was typed last when the typing does not pause", async () => {
    await mount();
    catalogue.take();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const input = one<HTMLInputElement>(root, "input[type=search]");
      input.value = "e";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(150);
      input.value = "edge";
      input.dispatchEvent(new Event("input"));
      // past when the first phrase would have been searched for, not yet the second
      vi.advanceTimersByTime(100);
    } finally {
      vi.useRealTimers();
    }
    await settle(fixture, catalogue, feedback);
    expect(catalogue.take()).toEqual([]);
    await search("edge");
    expect(catalogue.take()).toEqual([{ op: "search", args: { q: "edge", page: { first: 20 } }, shape: SHAPE }]);
  });

  it("says one result in the singular, and when nothing matches", async () => {
    await mount();
    await search("plan.pdf");
    expect(text(one(root, "p.status"))).toBe("1 result for “plan.pdf”, best match first");
    await search("zebra");
    expect(text(one(root, ".body.empty"))).toBe("Nothing matches “zebra” Try fewer words, a name, a SKU, or a tag.");
  });

  it("widens the same search for more results, and starts again from twenty on a new phrase", async () => {
    for (let i = 4; i <= 30; i++) db.products.push(product(`p${i}`, `Widget ${i}`, "Bulk", 100, "available"));
    await mount();
    await search("widget");
    catalogue.take();
    expect(text(one(root, "p.status"))).toBe("27 results for “widget”, best match first");
    expect(root.querySelectorAll(".card.product").length).toBe(20);

    await click(button(root, "Show more results"));
    expect(catalogue.take()).toEqual([{ op: "search", args: { q: "widget", page: { first: 40 } }, shape: SHAPE }]);
    expect(root.querySelectorAll(".card.product").length).toBe(27);
    expect(root.querySelector("p.more")).toBe(null);

    await search("widget 1");
    expect(catalogue.take()).toEqual([{ op: "search", args: { q: "widget 1", page: { first: 20 } }, shape: SHAPE }]);
  });

  it("shows the search's failure in the page", async () => {
    await mount(ADA, { search: "the index is rebuilding" });
    await search("noor");
    expect(text(one(root, "[role=alert]"))).toBe("The search failed the index is rebuilding");
  });

  it("opens a product with its margin for the product team, and the rest of its category", async () => {
    await mount(NOOR);
    catalogue.take();
    await click(root.querySelector<HTMLElement>(".card.product")!);
    expect(catalogue.take()).toEqual([
      {
        op: "product",
        args: { id: "p1" },
        shape: "{ id name sku summary category price cost availability updatedAt related { id name sku price availability summary } }",
      },
    ]);
    expect(text(one(root, "h1"))).toBe("Edge Router");
    expect(text(one(root, ".buy"))).toBe("€1,200 / year Available");
    expect(all(root, ".facts dd")).toEqual(["Networking", "SKU-p1", "Orderable now; provisioned within two working days.", "75% · costs us €300"]);
    expect(text(one(root, "h2.section-title"))).toBe("Also in Networking 1");
    expect(all(root, ".related .mini .name")).toEqual(["Core Switch"]);

    await click(one(root, ".related .mini"));
    expect(text(one(root, "h1"))).toBe("Core Switch");
    expect(all(root, ".facts dd")[2]).toBe("Orderable, with a lead time: a rollout engineer confirms the date.");

    await click(button(root, "Catalogue"));
    expect(root.querySelector("h1")?.textContent).toBe("Catalogue");
  });

  it("gives a product that is free a margin of nothing rather than a division by it", async () => {
    db.products[0]!["price"] = 0;
    db.products[0]!["cost"] = 0;
    await mount(NOOR);
    await click(root.querySelector<HTMLElement>(".card.product")!);
    expect(all(root, ".facts dd")[3]).toBe("0% · costs us €0");
  });

  it("keeps the margin from anyone outside the product team, and still shows the product", async () => {
    await mount(ADA);
    await click(root.querySelectorAll<HTMLElement>(".card.product")[2]!);
    expect(text(one(root, "h1"))).toBe("Patch Cable");
    expect(all(root, ".facts dd")[3]).toBe("Shown to the product team");
    expect(text(one(root, ".alone"))).toBe("The only product in its category.");
  });

  it("opens a person, their writing and their department, and goes on to a colleague or an article", async () => {
    await mount();
    catalogue.take();
    await click(root.querySelectorAll<HTMLElement>(".card.person")[1]!);
    expect(catalogue.take()).toEqual([
      {
        op: "person",
        args: { id: "u1" },
        shape: "{ id name title department email location updatedAt articles { id slug name summary tags updatedAt } colleagues { id name title location } }",
      },
    ]);
    expect(text(one(root, "h1"))).toBe("Ada Lovelace");
    expect(all(root, "h2.section-title")).toEqual(["Written by Ada 0", "Engineering 2"]);
    expect(text(one(root, ".none"))).toBe("Nothing in the knowledge base yet.");
    expect(one(root, "a.btn").getAttribute("href")).toBe("mailto:u1@keel.example");

    await click(one(root, ".colleagues .row"));
    expect(text(one(root, "h1"))).toBe("Lin Wei");

    await click(button(root, "Catalogue"));
    await click(root.querySelectorAll<HTMLElement>(".card.person")[0]!);
    expect(all(root, "h2.section-title")).toEqual(["Written by Noor 1", "Product 1"]);
    expect(text(one(root, ".columns section:last-child .none"))).toBe("The whole department.");
    expect(text(one(root, ".articles .row"))).toBe("Rollout runbook How a rollout goes Mar 4, 2026 · ops · runbook");
    await click(one(root, ".articles .row"));
    expect(text(one(root, "catalogue-article header h1"))).toBe("Rollout runbook");
  });

  describe("an article", () => {
    async function open(slugIndex = 0): Promise<void> {
      await click(root.querySelectorAll<HTMLElement>(".articles:not(.files) .row")[slugIndex]!);
    }

    it("reads with its body rendered, its version and its editor", async () => {
      await mount();
      catalogue.take();
      await open();
      expect(catalogue.take()).toEqual([
        { op: "article", args: { slug: "rollout-runbook" }, shape: "{ id slug name summary tags body version updatedAt publishedAt author { id name } editor { id name } }" },
      ]);
      expect(text(one(root, ".byline"))).toBe("Noor Haddad · updated Mar 4, 2026 · version 2 · last edited by Ada Lovelace");
      expect(one(root, ".prose").innerHTML).toBe("<h1>Steps</h1>\n<p>Do <strong>this</strong> first.</p>");
      expect(all(root, ".tags .pill")).toEqual(["ops", "runbook"]);
      expect(all(root, "header .actions button")).toEqual(["History", "Publish to the help centre", "Edit"]);
      expect(root.querySelector("catalogue-help-feedback")).toBe(null);
      expect(feedback.sent).toEqual([]);
    });

    it("saves an edit on the version it read, and draws the new version", async () => {
      await mount();
      await open();
      await click(button(root, "Edit"));
      const form = one<HTMLFormElement>(root, "form.edit");
      (form.elements.namedItem("name") as HTMLInputElement).value = "  Rollout guide ";
      (form.elements.namedItem("tags") as HTMLInputElement).value = "ops, , guide ";
      (form.elements.namedItem("body") as HTMLTextAreaElement).value = "New *body*";
      catalogue.take();
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await settle(fixture, catalogue, feedback);
      expect(catalogue.take().map(({ op, args, ifVersion }) => ({ op, args, ifVersion }))).toEqual([
        { op: "writeArticle", args: { id: "a1", name: "Rollout guide", summary: "How a rollout goes", body: "New *body*", tags: ["ops", "guide"] }, ifVersion: 2 },
        { op: "article", args: { slug: "rollout-runbook" }, ifVersion: undefined },
      ]);
      expect(root.querySelector("form.edit")).toBe(null);
      expect(text(one(root, "h1"))).toBe("Rollout guide");
      expect(text(one(root, ".byline"))).toBe("Noor Haddad · updated Mar 4, 2026 · version 3 · last edited by Ada Lovelace");
      expect(one(root, ".prose").innerHTML).toBe("<p>New <em>body</em></p>");
    });

    it("refuses an edit on top of someone else's and says so, keeping the form", async () => {
      await mount();
      await open();
      await click(button(root, "Edit"));
      db.articles[0]!.version = 5;
      one<HTMLFormElement>(root, "form.edit").dispatchEvent(new Event("submit", { cancelable: true }));
      await settle(fixture, catalogue, feedback);
      expect(root.querySelector("form.edit")).not.toBe(null);
      expect(text(one(root, "form.edit [role=alert]"))).toBe("Article:a1 is at version 5, not 2");
      expect(db.articles[0]!.name).toBe("Rollout runbook");

      await click(button(root, "Cancel"));
      expect(root.querySelector("form.edit")).toBe(null);
    });

    it("keeps what was typed when the refusal brings someone else's version with it", async () => {
      await mount();
      await open();
      await click(button(root, "Edit"));
      const form = one<HTMLFormElement>(root, "form.edit");
      (form.elements.namedItem("summary") as HTMLInputElement).value = "Mine, typed while Grace saved";
      (form.elements.namedItem("body") as HTMLTextAreaElement).value = "My *body*";
      // Grace saved first: the refusal carries her version, which reaches this page's cache
      Object.assign(db.articles[0]!, { version: 5, summary: "Grace's summary", body: "Grace's body" });
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      await settle(fixture, catalogue, feedback);
      expect(text(one(root, "form.edit [role=alert]"))).toBe("Article:a1 is at version 5, not 2");
      const kept = one<HTMLFormElement>(root, "form.edit");
      expect([(kept.elements.namedItem("summary") as HTMLInputElement).value, (kept.elements.namedItem("body") as HTMLTextAreaElement).value]).toEqual([
        "Mine, typed while Grace saved",
        "My *body*",
      ]);

      // guard: the form opened again starts from the version there is now
      await click(button(root, "Cancel"));
      expect(text(one(root, ".byline"))).toBe("Noor Haddad · updated Mar 4, 2026 · version 5 · last edited by Ada Lovelace");
      await click(button(root, "Edit"));
      expect((one<HTMLFormElement>(root, "form.edit").elements.namedItem("summary") as HTMLInputElement).value).toBe("Grace's summary");
    });

    it("publishes to the help centre and takes it off again, the patch alone changing the page", async () => {
      await mount();
      await open();
      catalogue.take();
      await click(button(root, "Publish to the help centre"));
      expect(catalogue.take()).toEqual([{ op: "publishArticle", args: { id: "a1", published: true }, shape: "{ id publishedAt }" }]);
      expect(text(one(root, ".byline"))).toBe("Noor Haddad · updated Mar 4, 2026 · version 2 · last edited by Ada Lovelace · on the help centre since Mar 5, 2026");
      expect(one(root, "a.public").getAttribute("href")).toBe("/help/rollout-runbook");
      expect(root.querySelector("catalogue-help-feedback")).not.toBe(null);

      await click(button(root, "Take off the help centre"));
      expect(catalogue.take()).toEqual([{ op: "publishArticle", args: { id: "a1", published: false }, shape: "{ id publishedAt }" }]);
      expect(root.querySelector("a.public")).toBe(null);
      expect(root.querySelector("catalogue-help-feedback")).toBe(null);
    });

    it("lists the history, reads an earlier version and restores it as a new edit", async () => {
      await mount();
      await open();
      catalogue.take();
      await click(button(root, "History"));
      expect(catalogue.take()).toEqual([
        { op: "articleRevisions", args: { id: "a1" }, shape: "{ items { id version name summary tags body at editor { name } } total }" },
      ]);
      expect(all(root, ".history li")).toEqual(["v2 Rollout runbook — current Ada Lovelace · Mar 4, 2026", "v1 Rollout notes Noor Haddad · Jan 10, 2026"]);
      expect(one(root, ".history li.on").classList.contains("current")).toBe(true);

      await click(root.querySelectorAll<HTMLElement>(".history li button")[1]!);
      expect(text(one(root, ".notice > span:first-child"))).toBe("Reading version 1, from Jan 10, 2026. The page is at version 2.");
      expect(one(root, ".prose").innerHTML).toBe("<p>Old <em>text</em></p>");
      expect(all(root, ".tags .pill")).toEqual(["draft"]);

      catalogue.take();
      await click(button(root, "Restore this version"));
      expect(catalogue.take().map(({ op, args, ifVersion }) => ({ op, args, ifVersion }))).toEqual([
        { op: "writeArticle", args: { id: "a1", name: "Rollout notes", summary: "Old", body: "Old *text*", tags: ["draft"] }, ifVersion: 2 },
        { op: "article", args: { slug: "rollout-runbook" }, ifVersion: undefined },
        { op: "articleRevisions", args: { id: "a1" }, ifVersion: undefined },
      ]);
      expect(root.querySelector(".notice")).toBe(null);
      expect(text(one(root, "h1"))).toBe("Rollout notes");
      expect(all(root, ".history li .v")).toEqual(["v3", "v2", "v1"]);

      await click(button(root, "History"));
      expect(root.querySelector(".history")).toBe(null);
    });

    it("names no editor when the author wrote the latest version too", async () => {
      db.articles[0]!.editorId = "u3";
      await mount();
      await open();
      expect(text(one(root, ".byline"))).toBe("Noor Haddad · updated Mar 4, 2026 · version 2");
    });

    it("reads the history again after an edit made while it is open", async () => {
      await mount();
      await open();
      await click(button(root, "History"));
      await click(button(root, "Edit"));
      catalogue.take();
      one<HTMLFormElement>(root, "form.edit").dispatchEvent(new Event("submit", { cancelable: true }));
      await settle(fixture, catalogue, feedback);
      expect(catalogue.take().map((s) => s.op)).toEqual(["writeArticle", "article", "articleRevisions"]);
      expect(all(root, ".history li .v")).toEqual(["v3", "v2", "v1"]);
    });

    it("shows no history button on a first version, and names no editor who is the author", async () => {
      await mount();
      await open(1);
      expect(text(one(root, ".byline"))).toBe("updated Mar 4, 2026 · on the help centre since Feb 1, 2026");
      expect([...root.querySelectorAll("button")].some((b) => text(b) === "History")).toBe(false);
    });

    it("on the help centre, shows what readers said, live as a visitor answers", async () => {
      ratings.push(
        { id: "x1", slug: "leave-policy", visitorId: "v1", helpful: true, comment: "Clear", at: T },
        { id: "x2", slug: "leave-policy", visitorId: "v2", helpful: true, comment: null, at: T },
        { id: "x3", slug: "leave-policy", visitorId: "v3", helpful: false, comment: "Too short", at: T },
        { id: "x4", slug: "other", visitorId: "v3", helpful: false, comment: "Elsewhere", at: T },
      );
      await mount();
      await open(1);
      expect(feedback.take()).toEqual([
        { op: "score", args: { slug: "leave-policy" }, shape: "{ id helpful unhelpful }", live: true },
        { op: "ratings", args: { slug: "leave-policy", page: { first: 20 } }, shape: "{ items { id helpful comment at } total }", live: true },
      ]);
      expect(text(one(root, ".tally"))).toBe("2 helped 1 did not 67% of 3 readers found it helpful");
      expect(all(root, ".said li")).toEqual(["Helped “Clear” Mar 4", "Did not help “Too short” Mar 4"]);
      expect([...root.querySelectorAll(".said .pill")].map((p) => p.className)).toEqual(["pill ok", "pill bad"]);
      expect(root.querySelector(".more")).toBe(null);

      await feedback.client({ visitor: "v9" }).command("rate", { slug: "leave-policy", helpful: false, comment: "Wrong" });
      await settle(fixture, catalogue, feedback);
      expect(text(one(root, ".tally"))).toBe("2 helped 2 did not 50% of 4 readers found it helpful");
      expect(all(root, ".said li")[0]).toBe("Did not help “Wrong” Mar 4");
    });

    it("says when nobody has answered, in the singular for one reader, and only the latest page of answers", async () => {
      db.articles[1]!.slug = "leave-policy";
      await mount();
      await open(1);
      expect(text(one(root, "section.readers p"))).toBe("Nobody has answered on this page yet.");

      await feedback.client({ visitor: "v1" }).command("rate", { slug: "leave-policy", helpful: true });
      await settle(fixture, catalogue, feedback);
      expect(text(one(root, ".tally"))).toBe("1 helped 0 did not 100% of 1 reader found it helpful");
      expect(root.querySelector(".said")).toBe(null);

      for (let i = 0; i < 21; i++) await feedback.client({ visitor: `w${i}` }).command("rate", { slug: "leave-policy", helpful: true, comment: `c${i}` });
      await settle(fixture, catalogue, feedback);
      expect(root.querySelectorAll(".said li").length).toBe(20);
      expect(text(one(root, ".more"))).toBe("The latest 20 of 22 answers.");
    });
  });
});

describe("what readers said, when the feedback service does not answer", () => {
  let fixture: ComponentFixture<HelpFeedback> | undefined;
  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  it("says so after four seconds of waiting, and not before", async () => {
    const stuck = { score: new Promise<never>(() => {}) };
    const feedback = new TestService(feedbackSchema, feedbackResolvers([], stuck), { member: { id: "u1", name: "Ada" } });
    TestBed.overrideComponent(HelpFeedback, { set: { providers: [provideRayfold(feedback.client())] } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture = TestBed.createComponent(HelpFeedback);
    fixture.componentRef.setInput("slug", "leave-policy");
    // not whenStable: from @rayfold/angular after 0.2.1 a query holds the application unstable until its first answer,
    // and this one never answers, which is the point
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector(".skeleton")).not.toBe(null);
    vi.advanceTimersByTime(3999);
    fixture.detectChanges();
    expect(root.querySelector("[role=status]")).toBe(null);
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(text(root.querySelector("[role=status]"))).toBe("The feedback service is not answering. It is retrying on its own; the page works without it.");
    feedback.close();
  });

  it("does not call a service slow while it shows what it already read from it", async () => {
    const stuck: { score?: Promise<never> } = {};
    const ratings: RatingRow[] = [{ id: "x1", slug: "leave-policy", visitorId: "v1", helpful: true, comment: null, at: T }];
    const answering = new TestService(feedbackSchema, feedbackResolvers(ratings, stuck), { member: { id: "u1", name: "Ada" } });
    const client = answering.client();
    TestBed.overrideComponent(HelpFeedback, { set: { providers: [{ provide: RAYFOLD_CLIENT, useFactory: () => client }] } });
    fixture = TestBed.createComponent(HelpFeedback);
    fixture.componentRef.setInput("slug", "leave-policy");
    await settle(fixture, answering);
    fixture.destroy();
    answering.close();

    // the same page opened again, with the answer in the client's cache and the service now silent
    stuck.score = new Promise<never>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture = TestBed.createComponent(HelpFeedback);
    fixture.componentRef.setInput("slug", "leave-policy");
    fixture.detectChanges();
    vi.advanceTimersByTime(5000);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector("[role=status]")).toBe(null);
    expect(text(root.querySelector(".tally"))).toBe("1 helped 0 did not 100% of 1 reader found it helpful");
    answering.close();
  });

  it("sends nothing without a page to ask about", async () => {
    const feedback = new TestService(feedbackSchema, feedbackResolvers([]), { member: { id: "u1", name: "Ada" } });
    TestBed.overrideComponent(HelpFeedback, { set: { providers: [provideRayfold(feedback.client())] } });
    fixture = TestBed.createComponent(HelpFeedback);
    await settle(fixture, feedback);
    expect(feedback.sent).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector(".skeleton")).not.toBe(null);
  });
});
