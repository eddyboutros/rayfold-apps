/**
 * The two services the help centre reads, as real Rayfold servers on their own schemas, over tables a spec owns.
 *
 * The resolvers keep each service's rules the way its SQL keeps them: the catalogue lists only published pages, A to
 * Z by address; the feedback service keeps one answer per visitor per page, and lists a visitor only their own.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";
import catalogueSchema from "../../../../services/catalogue/src/catalogue.rayfold?raw";
import feedbackSchema from "../../../../services/feedback/src/feedback.rayfold?raw";
import { TestService } from "./rayfold";

export interface PageRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  tags: string[];
  body: string;
  publishedAt: string | null;
}

export interface RatingRow {
  id: string;
  slug: string;
  visitorId: string;
  helpful: boolean;
  comment: string | null;
  at: string;
}

/** What a spec can make a service do instead of answering. */
export interface Faults {
  helpPages?: string;
  helpPage?: string;
  rate?: string;
}

export function catalogue(pages: PageRow[], faults: Faults = {}): TestService {
  const published = () => pages.filter((p) => p.publishedAt !== null).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const row = (p: PageRow) => ({ $type: "HelpPage", ...p });
  const resolvers = {
    Query: {
      helpPages: ({ page }: { page: { first: number } }) => {
        if (faults.helpPages) throw new RayfoldError("unavailable", faults.helpPages);
        const items = published().slice(0, page.first).map(row);
        return { items, total: published().length, hasMore: published().length > page.first, cursor: null };
      },
      helpPage: ({ slug }: { slug: string }) => {
        if (faults.helpPage) throw new RayfoldError("unavailable", faults.helpPage);
        const found = published().find((p) => p.slug === slug);
        return found ? row(found) : null;
      },
    },
  } as Resolvers;
  // every read reaches the catalogue anonymously: the gateway drops the cookie and Authorization on /api/help
  return new TestService(catalogueSchema, resolvers, null);
}

export interface Viewer {
  visitor?: string;
  member?: { id: string; name: string };
}

export function feedback(ratings: RatingRow[], visitor: string, faults: Faults = {}, now: () => string = () => "2026-03-05T12:00:00.000Z"): TestService {
  let next = ratings.length;
  const resolvers = {
    Query: {
      score: ({ slug }: { slug: string }) => {
        const mine = ratings.filter((r) => r.slug === slug);
        return { $type: "Score", id: slug, helpful: mine.filter((r) => r.helpful).length, unhelpful: mine.filter((r) => !r.helpful).length };
      },
      ratings: ({ slug, page }: { slug: string; page: { first: number } }, ctx: { viewer: Viewer }) => {
        // the service's read rule, as its SQL applies it: a member reads every answer, a visitor only their own
        const mine = ratings.filter((r) => r.slug === slug && (ctx.viewer.member || r.visitorId === ctx.viewer.visitor));
        return { items: mine.slice(0, page.first).map((r) => ({ $type: "Rating", ...r })), total: mine.length, hasMore: mine.length > page.first, cursor: null };
      },
    },
    Command: {
      rate: ({ slug, helpful, comment }: { slug: string; helpful: boolean; comment?: string | null }, ctx: { viewer: Viewer }) => {
        if (faults.rate) throw new RayfoldError("unavailable", faults.rate);
        const visitorId = ctx.viewer.visitor!;
        // one answer per visitor per page: answering again changes it, and it moves to the top
        const at = ratings.findIndex((r) => r.slug === slug && r.visitorId === visitorId);
        const kept = at >= 0 ? ratings.splice(at, 1)[0]! : { id: `r${++next}`, slug, visitorId };
        const rating: RatingRow = { ...kept, helpful, comment: comment?.trim() || null, at: now() };
        ratings.unshift(rating);
        return ok({ $type: "Rating", ...rating }, { patch: [{ inv: [`Score:${slug}`] }, { invOp: ["ratings"] }] });
      },
    },
  } as unknown as Resolvers;
  return new TestService(feedbackSchema, resolvers, { visitor });
}
