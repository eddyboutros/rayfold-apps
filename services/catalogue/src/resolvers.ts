/**
 * What the catalogue service does.
 *
 * Little, on purpose: the interesting parts are in the schema. `items` returns a page of an interface and `search` a
 * page of a union, and in both cases the resolver's only obligation is that every row says what it is in `$type`.
 * Rayfold projects each kind through the shape's `...on` conditions from there.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server";
import type { Article, ArticleRevision, CatalogueStore, Kind, Person, Product } from "./store.ts";

export interface Viewer {
  id: string;
  name?: string;
  /** What they do; the product team's title is what reads a product's cost. */
  title?: string;
}

export interface Parts {
  store: CatalogueStore;
  id?: () => string;
  now?: () => number;
}

interface PageArgs {
  first: number;
  after?: string | null;
  offset?: number | null;
}

/** A slug from a title: lower case, words joined by dashes, nothing else. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolvers({ store, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  return {
    Query: {
      search: async ({ q, page }: { q: string; page: PageArgs }) => {
        const { items, total } = await store.search(q, page.first, page.after ?? null);
        const from = page.after ? Number(page.after) : 0;
        return { items, total, hasMore: from + items.length < total, cursor: items.length ? String(from + items.length) : null };
      },

      items: async ({ kind, page }: { kind?: Kind | null; page: PageArgs }) => {
        const offset = page.offset ?? 0;
        const { items, total } = await store.items(kind ?? null, page.first, offset);
        return { items, total, hasMore: offset + items.length < total, cursor: null };
      },

      article: ({ slug }: { slug: string }) => store.article(slug),

      articleRevisions: async ({ id: articleId, page }: { id: string; page: PageArgs }) => {
        const { items, total } = await store.revisions(articleId, page.first, page.after ?? null);
        return { items, total, hasMore: items.length > 0 && total > items.length, cursor: items.length ? items[items.length - 1]!.id : null };
      },
      product: ({ id: productId }: { id: string }) => store.product(productId),
      person: ({ id: personId }: { id: string }) => store.person(personId),
    },

    Command: {
      writeArticle: async (
        { id: articleId, name, summary, body, tags }: { id?: string | null; name: string; summary: string; body: string; tags: string[] },
        ctx,
      ) => {
        const at = now();
        if (articleId) {
          const current = await store.articleById(articleId);
          if (!current) throw RayfoldError.domain("NotFound", { id: articleId }, `No article ${articleId}`);
          ctx.checkVersion(`Article:${current.id}`, current.version, current);
          const next: Article = { ...current, name, summary, body, tags, editorId: (ctx.viewer as Viewer).id, version: current.version + 1, updatedAt: at };
          if (ctx.simulate) return ok(next);
          // what is being replaced, kept under the version it was, by whoever wrote it
          const was: ArticleRevision = { id: id(), articleId: current.id, version: current.version, name: current.name, summary: current.summary, tags: current.tags, body: current.body, editorId: current.editorId, at: current.updatedAt };
          if (!(await store.updateArticle(next, current.version, was))) {
            const latest = await store.articleById(articleId);
            if (latest) ctx.checkVersion(`Article:${current.id}`, latest.version, latest);
            throw RayfoldError.domain("NotFound", { id: articleId }, `Article ${articleId} changed while this was running`);
          }
          return ok(next);
        }

        // a new page: its slug is its title, made unique by a suffix if the title has been used before
        const base = slugOf(name) || "untitled";
        let slug = base;
        for (let n = 2; await store.slugTaken(slug); n++) slug = `${base}-${n}`;
        const article: Article = { $type: "Article", id: id(), name, slug, summary, tags, authorId: (ctx.viewer as Viewer).id, editorId: (ctx.viewer as Viewer).id, body, version: 1, updatedAt: at };
        if (ctx.simulate) return ok(article);
        await store.createArticle(article);
        return ok(article);
      },
    },

    Article: {
      author: async (articles: Article[]) => {
        const people = await store.peopleByIds([...new Set(articles.map((a) => a.authorId).filter((x): x is string => !!x))]);
        return articles.map((a) => (a.authorId ? (people.get(a.authorId) ?? null) : null));
      },
      editor: async (articles: Article[]) => {
        const people = await store.peopleByIds([...new Set(articles.map((a) => a.editorId).filter((x): x is string => !!x))]);
        return articles.map((a) => (a.editorId ? (people.get(a.editorId) ?? null) : null));
      },
    },

    ArticleRevision: {
      editor: async (revisions: ArticleRevision[]) => {
        const people = await store.peopleByIds([...new Set(revisions.map((r) => r.editorId).filter((x): x is string => !!x))]);
        return revisions.map((r) => (r.editorId ? (people.get(r.editorId) ?? null) : null));
      },
    },

    // one read for a whole page, however many parents: the loader is handed every product on the page at once
    Product: {
      related: async (products: Product[]) => {
        const all = await store.productsInCategories([...new Set(products.map((p) => p.category))]);
        return products.map((p) => all.filter((o) => o.category === p.category && o.id !== p.id));
      },
    },

    Person: {
      articles: async (people: Person[]) => {
        const all = await store.articlesBy(people.map((p) => p.id));
        return people.map((p) => all.filter((a) => a.authorId === p.id));
      },
      colleagues: async (people: Person[]) => {
        const all = await store.peopleInDepartments([...new Set(people.map((p) => p.department))]);
        return people.map((p) => all.filter((o) => o.department === p.department && o.id !== p.id));
      },
    },
  } satisfies Resolvers as Resolvers;
}
