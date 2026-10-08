/**
 * What the feedback service does: takes an answer, counts them, and lists them to whoever may read them.
 */
import { ok, type Resolvers } from "@rayfold/server";
import type { FeedbackStore } from "./store.ts";

/**
 * Who is asking. A visitor is anyone on the help centre, by the cookie this service gave them; a member is someone
 * on the team, by the session cookie Keel's sign-in sets. A signed-in person reading the help centre is both.
 */
export interface Viewer {
  visitor?: string;
  member?: { id: string; name: string };
}

export interface Parts {
  store: FeedbackStore;
  id?: () => string;
  now?: () => number;
}

interface PageArgs {
  first: number;
  after?: string | null;
}

export function resolvers({ store, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  return {
    Query: {
      score: ({ slug }: { slug: string }) => store.score(slug),

      ratings: async ({ slug, page }: { slug: string; page: PageArgs }, ctx) => {
        // the runtime hands over the part of Rating's read rule it can push down; without it, a visitor's list would
        // hold other visitors' answers and the runtime would refuse the whole list rather than show them
        const { items, total, hasMore } = await store.ratings(slug, page.first, page.after ?? null, { filter: ctx.policy.filter, viewer: ctx.viewer, now: ctx.now });
        const last = items[items.length - 1];
        return { items, total, hasMore, cursor: last ? `${last.at}|${last.id}` : null };
      },
    },

    Command: {
      rate: async ({ slug, helpful, comment }: { slug: string; helpful: boolean; comment?: string | null }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const rating = await store.rate({ id: id(), slug, visitorId: viewer.visitor!, helpful, comment: comment?.trim() || null, at: now() });
        // the page's score is one entity, by its slug, so every open copy of it re-runs; a list of answers re-runs
        // whatever page it is on, which is what a member watching the page wants
        return ok(rating, { patch: [{ inv: [`Score:${slug}`] }, { invOp: ["ratings"] }] });
      },
    },
  } satisfies Resolvers as Resolvers;
}
