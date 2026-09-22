/**
 * The catalogue's tables, and the one query that reads all three at once.
 *
 * Search is Postgres's own full text search over a union of the three tables: each row comes back with the kind it
 * is, and the resolver hands that kind to Rayfold as `$type`. That is the whole of what a union costs here.
 */
import type pg from "pg";
import { SEED } from "./seed.ts";

export type Availability = "available" | "limited" | "waitlist" | "retired";
export type Kind = "product" | "person" | "article";

export interface Product {
  $type: "Product";
  id: string;
  name: string;
  sku: string;
  summary: string;
  category: string;
  price: number;
  availability: Availability;
  updatedAt: number;
}

export interface Person {
  $type: "Person";
  id: string;
  name: string;
  title: string;
  department: string;
  email: string;
  location: string;
  updatedAt: number;
}

export interface Article {
  $type: "Article";
  id: string;
  name: string;
  slug: string;
  summary: string;
  tags: string[];
  authorId: string | null;
  body: string;
  version: number;
  updatedAt: number;
}

export type Item = Product | Person | Article;

export const SCHEMA = `
  create table if not exists products (
    id text primary key,
    name text not null,
    sku text not null unique,
    summary text not null,
    category text not null,
    price int not null,
    availability text not null,
    updated_at bigint not null
  );

  create table if not exists people (
    id text primary key,
    name text not null,
    title text not null,
    department text not null,
    email text not null unique,
    location text not null,
    updated_at bigint not null
  );

  create table if not exists articles (
    id text primary key,
    name text not null,
    slug text not null unique,
    summary text not null,
    tags text[] not null default '{}',
    author_id text references people(id),
    body text not null,
    version int not null,
    updated_at bigint not null
  );
`;

const TABLE: Record<Kind, string> = { product: "products", person: "people", article: "articles" };
const TYPE: Record<Kind, Item["$type"]> = { product: "Product", person: "Person", article: "Article" };

/** What one kind contributes to the search: the columns to rank a phrase against, weighted by how much they say. */
const SEARCHABLE: Record<Kind, string> = {
  product: "setweight(to_tsvector('english', name || ' ' || sku), 'A') || setweight(to_tsvector('english', summary || ' ' || category), 'B')",
  person: "setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', title || ' ' || department || ' ' || location), 'B')",
  article: "setweight(to_tsvector('english', name || ' ' || array_to_string(tags, ' ')), 'A') || setweight(to_tsvector('english', summary), 'B') || setweight(to_tsvector('english', body), 'C')",
};

const toProduct = (r: Record<string, unknown>): Product => ({
  $type: "Product",
  id: r["id"] as string,
  name: r["name"] as string,
  sku: r["sku"] as string,
  summary: r["summary"] as string,
  category: r["category"] as string,
  price: r["price"] as number,
  availability: r["availability"] as Availability,
  updatedAt: Number(r["updated_at"]),
});

const toPerson = (r: Record<string, unknown>): Person => ({
  $type: "Person",
  id: r["id"] as string,
  name: r["name"] as string,
  title: r["title"] as string,
  department: r["department"] as string,
  email: r["email"] as string,
  location: r["location"] as string,
  updatedAt: Number(r["updated_at"]),
});

const toArticle = (r: Record<string, unknown>): Article => ({
  $type: "Article",
  id: r["id"] as string,
  name: r["name"] as string,
  slug: r["slug"] as string,
  summary: r["summary"] as string,
  tags: r["tags"] as string[],
  authorId: (r["author_id"] as string | null) ?? null,
  body: r["body"] as string,
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
});

const convert: Record<Kind, (r: Record<string, unknown>) => Item> = { product: toProduct, person: toPerson, article: toArticle };

export class CatalogueStore {
  constructor(private readonly sql: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.sql.query(SCHEMA);
    // reference data: what the company sells, who works here, what is written down. it is the catalogue's to
    // have from the first start, and it is never written twice
    await this.sql.query(SEED);
  }

  async product(id: string): Promise<Product | null> {
    const { rows } = await this.sql.query("select * from products where id = $1", [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async person(id: string): Promise<Person | null> {
    const { rows } = await this.sql.query("select * from people where id = $1", [id]);
    return rows[0] ? toPerson(rows[0]) : null;
  }

  async peopleByIds(ids: string[]): Promise<Map<string, Person>> {
    if (!ids.length) return new Map();
    const { rows } = await this.sql.query("select * from people where id = any($1::text[])", [ids]);
    return new Map(rows.map((r) => [r["id"] as string, toPerson(r)]));
  }

  async article(slug: string): Promise<Article | null> {
    const { rows } = await this.sql.query("select * from articles where slug = $1", [slug]);
    return rows[0] ? toArticle(rows[0]) : null;
  }

  async articleById(id: string): Promise<Article | null> {
    const { rows } = await this.sql.query("select * from articles where id = $1", [id]);
    return rows[0] ? toArticle(rows[0]) : null;
  }

  /**
   * A numbered page of one kind, or of all three: most recently changed first. Every kind is read with the same
   * three columns first, so one `order by` serves whichever mix the page holds.
   */
  async items(kind: Kind | null, first: number, offset: number): Promise<{ items: Item[]; total: number }> {
    const kinds: Kind[] = kind ? [kind] : ["product", "person", "article"];
    const union = kinds.map((k) => `select '${k}' as kind, id, updated_at from ${TABLE[k]}`).join(" union all ");
    const { rows } = await this.sql.query(`select kind, id from (${union}) all_items order by updated_at desc, id limit $1 offset $2`, [first, offset]);
    const { rows: counted } = await this.sql.query(`select count(*)::int as n from (${union}) all_items`);
    return { items: await this.load(rows as Array<{ kind: Kind; id: string }>), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  /** Everything matching a phrase, best match first, then newest. */
  async search(q: string, first: number, after: string | null): Promise<{ items: Item[]; total: number }> {
    const kinds: Kind[] = ["product", "person", "article"];
    const ranked = kinds
      .map((k) => `select '${k}' as kind, id, updated_at, ts_rank(${SEARCHABLE[k]}, query) as rank from ${TABLE[k]}, plainto_tsquery('english', $1) query where ${SEARCHABLE[k]} @@ query`)
      .join(" union all ");
    // the cursor is the position of the last row handed out: a ranking is stable for one phrase, which is all a
    // cursor needs to be
    const offset = after ? Number(after) : 0;
    const { rows } = await this.sql.query(`select kind, id from (${ranked}) hits order by rank desc, updated_at desc, id limit $2 offset $3`, [q, first, offset]);
    const { rows: counted } = await this.sql.query(`select count(*)::int as n from (${ranked}) hits`, [q]);
    return { items: await this.load(rows as Array<{ kind: Kind; id: string }>), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  /** The rows behind a list of (kind, id), in the list's order: one query per kind, however many rows. */
  private async load(refs: Array<{ kind: Kind; id: string }>): Promise<Item[]> {
    const byKind = new Map<Kind, string[]>();
    for (const { kind, id } of refs) byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    const found = new Map<string, Item>();
    for (const [kind, ids] of byKind) {
      const { rows } = await this.sql.query(`select * from ${TABLE[kind]} where id = any($1::text[])`, [ids]);
      for (const r of rows) found.set(`${TYPE[kind]}:${r["id"]}`, convert[kind](r));
    }
    return refs.map(({ kind, id }) => found.get(`${TYPE[kind]}:${id}`)).filter((x): x is Item => !!x);
  }

  async createArticle(a: Article): Promise<void> {
    await this.sql.query(
      "insert into articles (id, name, slug, summary, tags, author_id, body, version, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [a.id, a.name, a.slug, a.summary, a.tags, a.authorId, a.body, a.version, a.updatedAt],
    );
  }

  /** Lands only while the version is what the caller read; two edits cannot both win. */
  async updateArticle(a: Article, fromVersion: number): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      "update articles set name = $2, summary = $3, tags = $4, body = $5, version = $6, updated_at = $7 where id = $1 and version = $8",
      [a.id, a.name, a.summary, a.tags, a.body, a.version, a.updatedAt, fromVersion],
    );
    return !!rowCount;
  }

  async slugTaken(slug: string): Promise<boolean> {
    const { rowCount } = await this.sql.query("select 1 from articles where slug = $1", [slug]);
    return !!rowCount;
  }
}
