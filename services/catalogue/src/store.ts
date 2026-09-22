/**
 * The catalogue's tables, and the one query that reads all three at once.
 *
 * Search is Postgres's own full text search over a union of the three tables: each row comes back with the kind it
 * is, and the resolver hands that kind to Rayfold as `$type`. That is the whole of what a union costs here.
 */
import type pg from "pg";
import { SEED } from "./seed.ts";

export type Availability = "available" | "limited" | "waitlist" | "retired";
export type Kind = "product" | "person" | "article" | "file";

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
  /** Who wrote the current version; the author until someone edits it. */
  editorId: string | null;
  body: string;
  version: number;
  updatedAt: number;
}

export interface ArticleRevision {
  id: string;
  articleId: string;
  version: number;
  name: string;
  summary: string;
  tags: string[];
  body: string;
  editorId: string | null;
  at: number;
}

export interface File {
  $type: "File";
  id: string;
  name: string;
  projectId: string;
  contentType: string;
  size: number;
  url: string;
  excerpt: string;
  version: number;
  updatedAt: number;
}

export type Item = Product | Person | Article | File;

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
  -- added later: who wrote the current version. rows from before were written by their author
  alter table articles add column if not exists editor_id text references people(id);

  create table if not exists article_revisions (
    id text primary key,
    article_id text not null references articles(id) on delete cascade,
    version int not null,
    name text not null,
    summary text not null,
    tags text[] not null default '{}',
    body text not null,
    editor_id text references people(id),
    at bigint not null,
    unique (article_id, version)
  );

  -- what the extract-text worker writes: the document's text, and enough about it to show a result. the id is the
  -- documents service's id for it, so a new version of the same document replaces the row rather than adding one
  create table if not exists files (
    id text primary key,
    name text not null,
    project_id text not null,
    content_type text not null,
    size bigint not null,
    url text not null,
    text text not null,
    version int not null,
    updated_at bigint not null
  );
`;

const TABLE: Record<Kind, string> = { product: "products", person: "people", article: "articles", file: "files" };
const TYPE: Record<Kind, Item["$type"]> = { product: "Product", person: "Person", article: "Article", file: "File" };

/** What one kind contributes to the search: the columns to rank a phrase against, weighted by how much they say. */
const SEARCHABLE: Record<Kind, string> = {
  product: "setweight(to_tsvector('english', name || ' ' || sku), 'A') || setweight(to_tsvector('english', summary || ' ' || category), 'B')",
  person: "setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', title || ' ' || department || ' ' || location), 'B')",
  article: "setweight(to_tsvector('english', name || ' ' || array_to_string(tags, ' ')), 'A') || setweight(to_tsvector('english', summary), 'B') || setweight(to_tsvector('english', body), 'C')",
  file: "setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', text), 'C')",
};

/** The first lines of a text, for a result: enough to recognise the file, not enough to read it here. */
export function excerptOf(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

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
  editorId: (r["editor_id"] as string | null) ?? (r["author_id"] as string | null) ?? null,
  body: r["body"] as string,
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
});

const toRevision = (r: Record<string, unknown>): ArticleRevision => ({
  id: r["id"] as string,
  articleId: r["article_id"] as string,
  version: r["version"] as number,
  name: r["name"] as string,
  summary: r["summary"] as string,
  tags: r["tags"] as string[],
  body: r["body"] as string,
  editorId: (r["editor_id"] as string | null) ?? null,
  at: Number(r["at"]),
});

const toFile = (r: Record<string, unknown>): File => ({
  $type: "File",
  id: r["id"] as string,
  name: r["name"] as string,
  projectId: r["project_id"] as string,
  contentType: r["content_type"] as string,
  size: Number(r["size"]),
  url: r["url"] as string,
  excerpt: excerptOf(r["text"] as string),
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
});

const convert: Record<Kind, (r: Record<string, unknown>) => Item> = { product: toProduct, person: toPerson, article: toArticle, file: toFile };

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

  /** Everyone in any of these departments, by name: one read for a whole page of people, grouped by the caller. */
  async peopleInDepartments(departments: string[]): Promise<Person[]> {
    if (!departments.length) return [];
    const { rows } = await this.sql.query("select * from people where department = any($1::text[]) order by name", [departments]);
    return rows.map(toPerson);
  }

  /** Every product in any of these categories, newest first. */
  async productsInCategories(categories: string[]): Promise<Product[]> {
    if (!categories.length) return [];
    const { rows } = await this.sql.query("select * from products where category = any($1::text[]) order by updated_at desc, id", [categories]);
    return rows.map(toProduct);
  }

  /** Everything these people wrote, newest first. */
  async articlesBy(authorIds: string[]): Promise<Article[]> {
    if (!authorIds.length) return [];
    const { rows } = await this.sql.query("select * from articles where author_id = any($1::text[]) order by updated_at desc, id", [authorIds]);
    return rows.map(toArticle);
  }

  async revisions(articleId: string, first: number, after: string | null): Promise<{ items: ArticleRevision[]; total: number }> {
    const { rows } = await this.sql.query(
      "select * from article_revisions where article_id = $1 and ($2::text is null or version < (select version from article_revisions where id = $2)) order by version desc limit $3",
      [articleId, after, first],
    );
    const { rows: counted } = await this.sql.query("select count(*)::int as n from article_revisions where article_id = $1", [articleId]);
    return { items: rows.map(toRevision), total: (counted[0]?.["n"] as number) ?? 0 };
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
    const kinds: Kind[] = kind ? [kind] : ["product", "person", "article", "file"];
    const union = kinds.map((k) => `select '${k}' as kind, id, updated_at from ${TABLE[k]}`).join(" union all ");
    const { rows } = await this.sql.query(`select kind, id from (${union}) all_items order by updated_at desc, id limit $1 offset $2`, [first, offset]);
    const { rows: counted } = await this.sql.query(`select count(*)::int as n from (${union}) all_items`);
    return { items: await this.load(rows as Array<{ kind: Kind; id: string }>), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  /** Everything matching a phrase, best match first, then newest. */
  async search(q: string, first: number, after: string | null): Promise<{ items: Item[]; total: number }> {
    const kinds: Kind[] = ["product", "person", "article", "file"];
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
      "insert into articles (id, name, slug, summary, tags, author_id, editor_id, body, version, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [a.id, a.name, a.slug, a.summary, a.tags, a.authorId, a.editorId, a.body, a.version, a.updatedAt],
    );
  }

  /**
   * Lands only while the version is what the caller read; two edits cannot both win. The version being replaced is
   * kept as a revision in the same transaction, so an article never has an edit without the text it replaced.
   */
  async updateArticle(a: Article, fromVersion: number, was: ArticleRevision): Promise<boolean> {
    const client = await this.sql.connect();
    try {
      await client.query("begin");
      const { rowCount } = await client.query(
        "update articles set name = $2, summary = $3, tags = $4, body = $5, version = $6, updated_at = $7, editor_id = $9 where id = $1 and version = $8",
        [a.id, a.name, a.summary, a.tags, a.body, a.version, a.updatedAt, fromVersion, a.editorId],
      );
      if (!rowCount) {
        await client.query("rollback");
        return false;
      }
      await client.query(
        "insert into article_revisions (id, article_id, version, name, summary, tags, body, editor_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [was.id, was.articleId, was.version, was.name, was.summary, was.tags, was.body, was.editorId, was.at],
      );
      await client.query("commit");
      return true;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Keeps a document's text, replacing what an earlier version left. A version older than the one already kept is
   * left alone: the queue is at-least-once and two versions' jobs can finish in either order.
   */
  async indexFile(file: Omit<File, "$type" | "excerpt"> & { text: string }): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      `insert into files (id, name, project_id, content_type, size, url, text, version, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set name = excluded.name, project_id = excluded.project_id, content_type = excluded.content_type,
         size = excluded.size, url = excluded.url, text = excluded.text, version = excluded.version, updated_at = excluded.updated_at
       where files.version <= excluded.version`,
      [file.id, file.name, file.projectId, file.contentType, file.size, file.url, file.text, file.version, file.updatedAt],
    );
    return !!rowCount;
  }

  async removeFile(id: string): Promise<void> {
    await this.sql.query("delete from files where id = $1", [id]);
  }

  async slugTaken(slug: string): Promise<boolean> {
    const { rowCount } = await this.sql.query("select 1 from articles where slug = $1", [slug]);
    return !!rowCount;
  }
}
