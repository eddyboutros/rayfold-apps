/**
 * The workspace service's tables.
 *
 * `activity` is the one worth looking at: rows arrive from this service's own commands and from events other
 * services raised, and `source` says which. Nothing here reads another service's tables to build it.
 */
import type pg from "pg";

export type IssueState = "open" | "doing" | "done";

export interface Member {
  id: string;
  name: string;
}

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  state: IssueState;
  assigneeId: string | null;
  version: number;
  updatedAt: number;
}

export interface Comment {
  id: string;
  issueId: string;
  body: string;
  at: number;
  byId: string;
}

export interface Activity {
  id: string;
  projectId: string;
  source: string;
  kind: string;
  text: string;
  at: number;
}

export const SCHEMA = `
  create table if not exists members (
    id text primary key,
    name text not null
  );

  create table if not exists issues (
    id text primary key,
    project_id text not null,
    title text not null,
    state text not null,
    assignee_id text references members(id),
    version int not null,
    updated_at bigint not null
  );
  create index if not exists issues_project on issues (project_id, id);

  create table if not exists comments (
    id text primary key,
    issue_id text not null references issues(id) on delete cascade,
    body text not null,
    at bigint not null,
    by_id text not null references members(id)
  );
  create index if not exists comments_issue on comments (issue_id, at);

  create table if not exists activity (
    id text primary key,
    project_id text not null,
    source text not null,
    kind text not null,
    text text not null,
    at bigint not null
  );
  create index if not exists activity_project on activity (project_id, at desc);
`;

export const SEED = `
  insert into members (id, name) values ('u1', 'Ada'), ('u2', 'Grace')
  on conflict (id) do nothing;
`;

const toIssue = (r: Record<string, unknown>): Issue => ({
  id: r["id"] as string,
  projectId: r["project_id"] as string,
  title: r["title"] as string,
  state: r["state"] as IssueState,
  assigneeId: (r["assignee_id"] as string | null) ?? null,
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
});

const toComment = (r: Record<string, unknown>): Comment => ({
  id: r["id"] as string,
  issueId: r["issue_id"] as string,
  body: r["body"] as string,
  at: Number(r["at"]),
  byId: r["by_id"] as string,
});

const toActivity = (r: Record<string, unknown>): Activity => ({
  id: r["id"] as string,
  projectId: r["project_id"] as string,
  source: r["source"] as string,
  kind: r["kind"] as string,
  text: r["text"] as string,
  at: Number(r["at"]),
});

export class WorkspaceStore {
  constructor(private readonly sql: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.sql.query(SCHEMA);
    await this.sql.query(SEED);
  }

  async issue(id: string): Promise<Issue | null> {
    const { rows } = await this.sql.query("select * from issues where id = $1", [id]);
    return rows[0] ? toIssue(rows[0]) : null;
  }

  async issues(projectId: string, first: number, after: string | null): Promise<{ items: Issue[]; total: number }> {
    const { rows } = await this.sql.query(
      "select * from issues where project_id = $1 and ($2::text is null or id > $2) order by id limit $3",
      [projectId, after, first],
    );
    const { rows: n } = await this.sql.query("select count(*)::int as n from issues where project_id = $1", [projectId]);
    return { items: rows.map(toIssue), total: (n[0]?.["n"] as number) ?? 0 };
  }

  async comments(issueId: string, first: number, after: string | null): Promise<{ items: Comment[]; total: number }> {
    const { rows } = await this.sql.query(
      "select * from comments where issue_id = $1 and ($2::text is null or id > $2) order by at, id limit $3",
      [issueId, after, first],
    );
    const { rows: n } = await this.sql.query("select count(*)::int as n from comments where issue_id = $1", [issueId]);
    return { items: rows.map(toComment), total: (n[0]?.["n"] as number) ?? 0 };
  }

  async activity(projectId: string, first: number, after: string | null): Promise<{ items: Activity[]; total: number }> {
    const { rows } = await this.sql.query(
      `select * from activity where project_id = $1
         and ($2::text is null or at < (select at from activity where id = $2))
       order by at desc, id desc limit $3`,
      [projectId, after, first],
    );
    const { rows: n } = await this.sql.query("select count(*)::int as n from activity where project_id = $1", [projectId]);
    return { items: rows.map(toActivity), total: (n[0]?.["n"] as number) ?? 0 };
  }

  async membersByIds(ids: string[]): Promise<Map<string, Member>> {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return new Map();
    const { rows } = await this.sql.query("select * from members where id = any($1::text[])", [wanted]);
    return new Map(rows.map((r) => [r["id"] as string, { id: r["id"] as string, name: r["name"] as string }]));
  }

  async createIssue(issue: Issue): Promise<void> {
    await this.sql.query(
      "insert into issues (id, project_id, title, state, assignee_id, version, updated_at) values ($1,$2,$3,$4,$5,$6,$7)",
      [issue.id, issue.projectId, issue.title, issue.state, issue.assigneeId, issue.version, issue.updatedAt],
    );
  }

  /** Moves the issue only while its version is still what the caller read: two moves cannot both win. */
  async moveIssue(id: string, to: IssueState, fromVersion: number, at: number): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      "update issues set state = $2, version = version + 1, updated_at = $3 where id = $1 and version = $4",
      [id, to, at, fromVersion],
    );
    return !!rowCount;
  }

  async addComment(comment: Comment): Promise<void> {
    await this.sql.query("insert into comments (id, issue_id, body, at, by_id) values ($1,$2,$3,$4,$5)", [
      comment.id,
      comment.issueId,
      comment.body,
      comment.at,
      comment.byId,
    ]);
  }

  /** One line on a project's feed. `source` is the service it came from, which is the only trace of where it began. */
  async record(entry: Activity): Promise<void> {
    await this.sql.query("insert into activity (id, project_id, source, kind, text, at) values ($1,$2,$3,$4,$5,$6)", [
      entry.id,
      entry.projectId,
      entry.source,
      entry.kind,
      entry.text,
      entry.at,
    ]);
  }
}
