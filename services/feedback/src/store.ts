/**
 * The answers, one row per visitor per page, and the two counts a page is known by.
 *
 * Who may read a row is the schema's rule, not this file's: `ratings` takes the part of it the runtime can push down
 * (`ctx.policy.filter`) and has `@rayfold/postgres` turn it into SQL, so the WHERE that keeps a visitor to their own
 * answers is derived from the same line of the schema that the runtime checks every row against.
 */
import type pg from "pg";
import { compilePolicy, type PolicyColumn } from "@rayfold/postgres";
import type { Expr } from "@rayfold/schema";

export interface Rating {
  id: string;
  slug: string;
  visitorId: string;
  helpful: boolean;
  comment: string | null;
  /** RFC 3339, in UTC, as the schema's Instant is on the wire. */
  at: string;
}

export interface Score {
  id: string;
  helpful: number;
  unhelpful: number;
}

export const SCHEMA = `
  create table if not exists ratings (
    id text primary key,
    slug text not null,
    visitor_id text not null,
    helpful boolean not null,
    comment text,
    at timestamptz not null,
    -- one answer per visitor per page: answering again is an update, which is what makes the counts honest
    unique (slug, visitor_id)
  );
  create index if not exists ratings_slug_at on ratings (slug, at desc, id desc);
`;

/** The columns a policy on Rating may read, with the scalar type of each field, for the SQL the policy becomes. */
const COLUMNS: Record<string, PolicyColumn> = {
  id: { column: "id", scalar: "ID" },
  slug: { column: "slug", scalar: "String" },
  visitorId: { column: "visitor_id", scalar: "ID" },
  helpful: { column: "helpful", scalar: "Boolean" },
};

const toRating = (r: Record<string, unknown>): Rating => ({
  id: r["id"] as string,
  slug: r["slug"] as string,
  visitorId: r["visitor_id"] as string,
  helpful: r["helpful"] as boolean,
  comment: (r["comment"] as string | null) ?? null,
  at: (r["at"] as Date).toISOString(),
});

export interface Readable {
  /** The pushable part of Rating's read policy, as the runtime hands it to the resolver. */
  filter: Expr | undefined;
  viewer: unknown;
  now: () => number;
}

export class FeedbackStore {
  constructor(private readonly sql: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.sql.query(SCHEMA);
  }

  /** Answers or changes the answer; the row keeps the id it was first given. */
  async rate(r: Omit<Rating, "at"> & { at: number }): Promise<Rating> {
    const { rows } = await this.sql.query(
      `insert into ratings (id, slug, visitor_id, helpful, comment, at) values ($1, $2, $3, $4, $5, to_timestamp($6::float8 / 1000))
       on conflict (slug, visitor_id) do update set helpful = excluded.helpful, comment = excluded.comment, at = excluded.at
       returning *`,
      [r.id, r.slug, r.visitorId, r.helpful, r.comment, r.at],
    );
    return toRating(rows[0]!);
  }

  async score(slug: string): Promise<Score> {
    const { rows } = await this.sql.query(
      "select count(*) filter (where helpful)::int as helpful, count(*) filter (where not helpful)::int as unhelpful from ratings where slug = $1",
      [slug],
    );
    return { id: slug, helpful: (rows[0]?.["helpful"] as number) ?? 0, unhelpful: (rows[0]?.["unhelpful"] as number) ?? 0 };
  }

  /**
   * A page's answers, newest first, after a cursor (`<at>|<id>` of the last one handed out). Only the rows the
   * reader may see are read, and `total` counts only those: the policy is part of the WHERE.
   */
  async ratings(slug: string, first: number, after: string | null, readable: Readable): Promise<{ items: Rating[]; total: number; hasMore: boolean }> {
    const params: unknown[] = [slug];
    const where = ["slug = $1"];
    if (readable.filter) {
      const f = compilePolicy(readable.filter, { viewer: readable.viewer, args: {}, this: null, now: readable.now }, (field) => COLUMNS[field], params);
      where.push(f.sql);
    }
    const counted = `select count(*)::int as n from ratings where ${where.join(" and ")}`;
    const { rows: total } = await this.sql.query(counted, params);
    const page = [...params];
    let keyset = "";
    if (after) {
      const [at, id] = after.split("|");
      page.push(at, id);
      keyset = ` and (at, id) < ($${page.length - 1}::timestamptz, $${page.length}::text)`;
    }
    // one more than a page, to know whether there is another
    page.push(first + 1);
    const { rows } = await this.sql.query(`select * from ratings where ${where.join(" and ")}${keyset} order by at desc, id desc limit $${page.length}`, page);
    return { items: rows.slice(0, first).map(toRating), total: (total[0]?.["n"] as number) ?? 0, hasMore: rows.length > first };
  }
}
