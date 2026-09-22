/**
 * What the catalogue service does.
 *
 * Little, on purpose: the interesting parts are in the schema. `items` returns a page of an interface and `search` a
 * page of a union, and in both cases the resolver's only obligation is that every row says what it is in `$type`.
 * Rayfold projects each kind through the shape's `...on` conditions from there.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server";
import type { Article, CatalogueStore, Kind } from "./store.ts";

export interface Viewer {
  id: string;
  name?: string;
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
          const next: Article = { ...current, name, summary, body, tags, version: current.version + 1, updatedAt: at };
          if (ctx.simulate) return ok(next);
          if (!(await store.updateArticle(next, current.version))) {
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
        const article: Article = { $type: "Article", id: id(), name, slug, summary, tags, authorId: (ctx.viewer as Viewer).id, body, version: 1, updatedAt: at };
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
    },
  } satisfies Resolvers as Resolvers;
}
