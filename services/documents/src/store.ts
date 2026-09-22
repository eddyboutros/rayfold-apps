/**
 * The documents service's own tables, and the queries over them.
 *
 * Rows here hold what a document *is*; the bytes are a file, and the row carries the URL they are served at. That
 * split is the whole point of the service: a database is good at "which revision is current and who owns it" and
 * bad at holding a hundred megabytes twice on the way through.
 */
import { membersSeed } from "@apps/service-kit";
import type pg from "pg";

export interface Member {
  id: string;
  name: string;
}

export interface Document {
  id: string;
  name: string;
  projectId: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: number;
  ownerId: string;
  folder: string | null;
  tags: string[];
}

export interface Note {
  id: string;
  documentId: string;
  body: string;
  at: number;
  byId: string;
}

export interface Folder {
  name: string;
  count: number;
}

export interface DocumentFilter {
  folder: string | null;
  tag: string | null;
}

export interface Revision {
  id: string;
  documentId: string;
  version: number;
  size: number;
  url: string;
  at: number;
  byId: string;
}

/** Safe to run from every instance at once, like the platform's own. */
export const SCHEMA = `
  create table if not exists members (
    id text primary key,
    name text not null
  );

  create table if not exists documents (
    id text primary key,
    name text not null,
    content_type text not null,
    size bigint not null,
    url text not null,
    version int not null,
    updated_at bigint not null,
    owner_id text not null references members(id)
  );
  -- added after the first deploy: rows from before it belong to the first project
  alter table documents add column if not exists project_id text not null default 'p1';
  create index if not exists documents_project on documents (project_id, updated_at desc, id);
  -- added later: everything from before sits at the root with no tags
  alter table documents add column if not exists folder text;
  alter table documents add column if not exists tags text[] not null default '{}';

  create table if not exists notes (
    id text primary key,
    document_id text not null references documents(id) on delete cascade,
    body text not null,
    at bigint not null,
    by_id text not null references members(id)
  );
  create index if not exists notes_document on notes (document_id, at, id);

  create table if not exists revisions (
    id text primary key,
    document_id text not null references documents(id) on delete cascade,
    version int not null,
    size bigint not null,
    url text not null,
    at bigint not null,
    by_id text not null references members(id)
  );
  create index if not exists revisions_document on revisions (document_id, version desc);
`;

/** The team, so the service has owners the moment it starts. */
export const SEED = membersSeed();

const toDocument = (r: Record<string, unknown>): Document => ({
  id: r["id"] as string,
  name: r["name"] as string,
  projectId: r["project_id"] as string,
  contentType: r["content_type"] as string,
  // bigint arrives as text from pg, because not every bigint fits a double; these do, and the schema says Int
  size: Number(r["size"]),
  url: r["url"] as string,
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
  ownerId: r["owner_id"] as string,
  folder: (r["folder"] as string | null) ?? null,
  tags: (r["tags"] as string[] | null) ?? [],
});

const toNote = (r: Record<string, unknown>): Note => ({
  id: r["id"] as string,
  documentId: r["document_id"] as string,
  body: r["body"] as string,
  at: Number(r["at"]),
  byId: r["by_id"] as string,
});

const toRevision = (r: Record<string, unknown>): Revision => ({
  id: r["id"] as string,
  documentId: r["document_id"] as string,
  version: r["version"] as number,
  size: Number(r["size"]),
  url: r["url"] as string,
  at: Number(r["at"]),
  byId: r["by_id"] as string,
});

export class DocumentStore {
  constructor(private readonly sql: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.sql.query(SCHEMA);
    await this.sql.query(SEED);
  }

  async document(id: string): Promise<Document | null> {
    const { rows } = await this.sql.query("select * from documents where id = $1", [id]);
    return rows[0] ? toDocument(rows[0]) : null;
  }

  /** A project's documents, most recently changed first; in one folder or under one tag when asked. */
  async documentsOf(projectId: string, filter: DocumentFilter, first: number, after: string | null): Promise<{ items: Document[]; total: number }> {
    const where = "project_id = $1 and ($2::text is null or folder = $2) and ($3::text is null or $3 = any(tags))";
    const args = [projectId, filter.folder, filter.tag];
    const { rows } = await this.sql.query(
      `select * from documents where ${where}
         and ($4::text is null or (updated_at, id) < (select updated_at, id from documents where id = $4))
       order by updated_at desc, id desc limit $5`,
      [...args, after, first],
    );
    const { rows: counted } = await this.sql.query(`select count(*)::int as n from documents where ${where}`, args);
    return { items: rows.map(toDocument), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  async folders(projectId: string): Promise<Folder[]> {
    const { rows } = await this.sql.query("select folder as name, count(*)::int as count from documents where project_id = $1 and folder is not null group by folder order by folder", [projectId]);
    return rows.map((r) => ({ name: r["name"] as string, count: r["count"] as number }));
  }

  async notes(documentId: string, first: number, after: string | null): Promise<{ items: Note[]; total: number }> {
    const { rows } = await this.sql.query(
      "select * from notes where document_id = $1 and ($2::text is null or (at, id) > (select at, id from notes where id = $2)) order by at, id limit $3",
      [documentId, after, first],
    );
    const { rows: counted } = await this.sql.query("select count(*)::int as n from notes where document_id = $1", [documentId]);
    return { items: rows.map(toNote), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  async addNote(note: Note): Promise<void> {
    await this.sql.query("insert into notes (id, document_id, body, at, by_id) values ($1,$2,$3,$4,$5)", [note.id, note.documentId, note.body, note.at, note.byId]);
  }

  async revisionsOf(documentId: string, first: number, after: string | null): Promise<{ items: Revision[]; total: number }> {
    const { rows } = await this.sql.query(
      `select * from revisions where document_id = $1 and ($2::text is null or version < (select version from revisions where id = $2))
       order by version desc limit $3`,
      [documentId, after, first],
    );
    const { rows: counted } = await this.sql.query("select count(*)::int as n from revisions where document_id = $1", [documentId]);
    return { items: rows.map(toRevision), total: (counted[0]?.["n"] as number) ?? 0 };
  }

  /** The revision a `/files/{id}` request names, with the document it belongs to, so the route can apply the same rule. */
  async revisionWithDocument(revisionId: string): Promise<{ revision: Revision; document: Document } | null> {
    const { rows } = await this.sql.query(
      "select r.*, d.owner_id as d_owner, d.id as d_id, d.content_type as d_type from revisions r join documents d on d.id = r.document_id where r.id = $1",
      [revisionId],
    );
    const row = rows[0];
    if (!row) return null;
    const document = await this.document(row["document_id"] as string);
    return document ? { revision: toRevision(row), document } : null;
  }

  async member(id: string): Promise<Member | null> {
    const { rows } = await this.sql.query("select * from members where id = $1", [id]);
    return rows[0] ? { id: rows[0]["id"] as string, name: rows[0]["name"] as string } : null;
  }

  async membersByIds(ids: string[]): Promise<Map<string, Member>> {
    if (!ids.length) return new Map();
    const { rows } = await this.sql.query("select * from members where id = any($1::text[])", [ids]);
    return new Map(rows.map((r) => [r["id"] as string, { id: r["id"] as string, name: r["name"] as string }]));
  }

  /** The document and its first revision, written together: a document with no bytes is not a state worth having. */
  async create(doc: Document, revision: Revision): Promise<void> {
    const client = await this.sql.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into documents (id, name, project_id, content_type, size, url, version, updated_at, owner_id, folder, tags) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [doc.id, doc.name, doc.projectId, doc.contentType, doc.size, doc.url, doc.version, doc.updatedAt, doc.ownerId, doc.folder, doc.tags],
      );
      await client.query("insert into revisions (id, document_id, version, size, url, at, by_id) values ($1,$2,$3,$4,$5,$6,$7)", [
        revision.id,
        revision.documentId,
        revision.version,
        revision.size,
        revision.url,
        revision.at,
        revision.byId,
      ]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Moves the document to the new revision, in one statement that only lands if the version is still what the caller
   * read. Two replaces arriving together cannot both win: the loser updates no rows and is told so.
   */
  async replace(doc: Document, revision: Revision, fromVersion: number): Promise<boolean> {
    const client = await this.sql.connect();
    try {
      await client.query("begin");
      const { rowCount } = await client.query(
        "update documents set content_type = $2, size = $3, url = $4, version = $5, updated_at = $6 where id = $1 and version = $7",
        [doc.id, doc.contentType, doc.size, doc.url, doc.version, doc.updatedAt, fromVersion],
      );
      if (!rowCount) {
        await client.query("rollback");
        return false;
      }
      await client.query("insert into revisions (id, document_id, version, size, url, at, by_id) values ($1,$2,$3,$4,$5,$6,$7)", [
        revision.id,
        revision.documentId,
        revision.version,
        revision.size,
        revision.url,
        revision.at,
        revision.byId,
      ]);
      await client.query("commit");
      return true;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async rename(id: string, name: string, version: number, updatedAt: number): Promise<void> {
    await this.sql.query("update documents set name = $2, version = $3, updated_at = $4 where id = $1", [id, name, version, updatedAt]);
  }

  /** Lands only while the version is what the caller read, like a replace. */
  async file(id: string, folder: string | null, fromVersion: number, updatedAt: number): Promise<boolean> {
    const { rowCount } = await this.sql.query("update documents set folder = $2, version = version + 1, updated_at = $3 where id = $1 and version = $4", [id, folder, updatedAt, fromVersion]);
    return !!rowCount;
  }

  async tag(id: string, tags: string[], fromVersion: number, updatedAt: number): Promise<boolean> {
    const { rowCount } = await this.sql.query("update documents set tags = $2, version = version + 1, updated_at = $3 where id = $1 and version = $4", [id, tags, updatedAt, fromVersion]);
    return !!rowCount;
  }

  /** Deletes the document and answers with the revision ids, so their bytes can go too. */
  async remove(id: string): Promise<string[]> {
    const { rows } = await this.sql.query("select id from revisions where document_id = $1", [id]);
    await this.sql.query("delete from documents where id = $1", [id]);
    return rows.map((r) => r["id"] as string);
  }
}
