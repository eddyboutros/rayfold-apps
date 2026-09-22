/**
 * The workspace service's tables.
 *
 * `activity` is the one worth looking at: rows arrive from this service's own commands and from events other
 * services raised, and `source` says which. Nothing here reads another service's tables to build it.
 */
import { membersSeed } from "@apps/service-kit";
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

export interface Message {
  id: string;
  projectId: string;
  body: string;
  at: number;
  byId: string;
}

export interface Notification {
  id: string;
  recipientId: string;
  kind: string;
  text: string;
  projectId: string;
  issueId: string | null;
  at: number;
  readAt: number | null;
}

export interface Activity {
  id: string;
  projectId: string;
  source: string;
  kind: string;
  text: string;
  at: number;
  byId: string | null;
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
  -- added after the first deploy. no reference to members: a line relayed from another service may name someone
  -- this service has not heard of yet, and the line is still worth keeping
  alter table activity add column if not exists by_id text;

  create table if not exists messages (
    id text primary key,
    project_id text not null,
    body text not null,
    at bigint not null,
    by_id text not null references members(id)
  );
  create index if not exists messages_project on messages (project_id, at, id);

  create table if not exists notifications (
    id text primary key,
    recipient_id text not null references members(id),
    kind text not null,
    text text not null,
    project_id text not null,
    issue_id text,
    at bigint not null,
    read_at bigint
  );
  create index if not exists notifications_recipient on notifications (recipient_id, at desc);
`;

export const SEED = membersSeed();

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

const toMessage = (r: Record<string, unknown>): Message => ({
  id: r["id"] as string,
  projectId: r["project_id"] as string,
  body: r["body"] as string,
  at: Number(r["at"]),
  byId: r["by_id"] as string,
});

const toNotification = (r: Record<string, unknown>): Notification => ({
  id: r["id"] as string,
  recipientId: r["recipient_id"] as string,
  kind: r["kind"] as string,
  text: r["text"] as string,
  projectId: r["project_id"] as string,
  issueId: (r["issue_id"] as string | null) ?? null,
  at: Number(r["at"]),
  readAt: r["read_at"] === null ? null : Number(r["read_at"]),
});

const toActivity = (r: Record<string, unknown>): Activity => ({
  id: r["id"] as string,
  projectId: r["project_id"] as string,
  source: r["source"] as string,
  kind: r["kind"] as string,
  text: r["text"] as string,
  at: Number(r["at"]),
  byId: (r["by_id"] as string | null) ?? null,
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

  async messages(projectId: string, first: number, after: string | null): Promise<{ items: Message[]; total: number }> {
    // newest last, so a chat reads downwards; the page walks backwards from the newest, as a person scrolls up
    const { rows } = await this.sql.query(
      `select * from (
         select * from messages where project_id = $1 and ($2::text is null or (at, id) < (select at, id from messages where id = $2))
         order by at desc, id desc limit $3
       ) page order by at, id`,
      [projectId, after, first],
    );
    const { rows: n } = await this.sql.query("select count(*)::int as n from messages where project_id = $1", [projectId]);
    return { items: rows.map(toMessage), total: (n[0]?.["n"] as number) ?? 0 };
  }

  async say(m: Message): Promise<void> {
    await this.sql.query("insert into messages (id, project_id, body, at, by_id) values ($1,$2,$3,$4,$5)", [m.id, m.projectId, m.body, m.at, m.byId]);
  }

  async notifications(recipientId: string, first: number, after: string | null): Promise<{ items: Notification[]; total: number }> {
    const { rows } = await this.sql.query(
      `select * from notifications where recipient_id = $1
         and ($2::text is null or (at, id) < (select at, id from notifications where id = $2))
       order by at desc, id desc limit $3`,
      [recipientId, after, first],
    );
    const { rows: n } = await this.sql.query("select count(*)::int as n from notifications where recipient_id = $1", [recipientId]);
    return { items: rows.map(toNotification), total: (n[0]?.["n"] as number) ?? 0 };
  }

  async unread(recipientId: string): Promise<number> {
    const { rows } = await this.sql.query("select count(*)::int as n from notifications where recipient_id = $1 and read_at is null", [recipientId]);
    return (rows[0]?.["n"] as number) ?? 0;
  }

  /** Written once however many instances react: the id is derived from the cause, as the feed's lines are. */
  async notify(n: Notification): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      "insert into notifications (id, recipient_id, kind, text, project_id, issue_id, at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing",
      [n.id, n.recipientId, n.kind, n.text, n.projectId, n.issueId, n.at],
    );
    return !!rowCount;
  }

  /** Marks everything up to a moment as read, answering how many that was. Nothing is unmarked; done twice is done once. */
  async markRead(recipientId: string, upTo: number, at: number): Promise<number> {
    const { rowCount } = await this.sql.query("update notifications set read_at = $3 where recipient_id = $1 and at <= $2 and read_at is null", [recipientId, upTo, at]);
    return rowCount ?? 0;
  }

  async members(): Promise<Member[]> {
    const { rows } = await this.sql.query("select * from members order by name");
    return rows.map((r) => ({ id: r["id"] as string, name: r["name"] as string }));
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

  /** Same shape as a move: lands only while the version is what the caller read. */
  async assignIssue(id: string, assigneeId: string | null, fromVersion: number, at: number): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      "update issues set assignee_id = $2, version = version + 1, updated_at = $3 where id = $1 and version = $4",
      [id, assigneeId, at, fromVersion],
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

  /**
   * One line on a project's feed, written once however many instances try.
   *
   * A relayed event reaches *every* instance of this service, and each one reacts. That is correct — each has its
   * own connected clients to wake — but the write must not happen once per instance. So a reaction gives the line
   * an id derived from what caused it, and the second instance to arrive writes nothing.
   *
   * The id is what keeps the feed right; `on conflict` is what keeps the losing instance quiet. Without the clause
   * every replica but one raises a duplicate key on every event, which is a log full of errors that mean nothing.
   *
   * Answers whether this call is the one that wrote it.
   */
  async record(entry: Activity): Promise<boolean> {
    const { rowCount } = await this.sql.query(
      "insert into activity (id, project_id, source, kind, text, at, by_id) values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing",
      [entry.id, entry.projectId, entry.source, entry.kind, entry.text, entry.at, entry.byId],
    );
    return !!rowCount;
  }
}
