/**
 * The workspace service's tables.
 *
 * `activity` is the one worth looking at: rows arrive from this service's own commands and from events other
 * services raised, and `source` says which. Nothing here reads another service's tables to build it.
 */
import { membersSeed } from "@apps/service-kit";
import type pg from "pg";

export type IssueState = "open" | "doing" | "done";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Member {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
}

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  state: IssueState;
  assigneeId: string | null;
  priority: Priority;
  labels: string[];
  /** YYYY-MM-DD, or null when no day was set. */
  dueOn: string | null;
  description: string | null;
  version: number;
  updatedAt: number;
}

/** What `updateIssue` may change: a key that is present is written, one that is absent is left alone. */
export interface IssueChanges {
  title?: string;
  description?: string | null;
  priority?: Priority;
  labels?: string[];
  dueOn?: string | null;
}

export interface IssueFilter {
  state?: IssueState | null;
  assigneeId?: string | null;
  label?: string | null;
}

export interface Workload {
  member: Member;
  open: number;
  doing: number;
  done: number;
  overdue: number;
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
  -- added after the first deploy, each with what an existing row means: normal, no labels, no day, nothing written
  alter table issues add column if not exists priority text not null default 'normal';
  alter table issues add column if not exists labels text[] not null default '{}';
  alter table issues add column if not exists due_on text;
  alter table issues add column if not exists description text;
  create index if not exists issues_assignee on issues (assignee_id, state);

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
  priority: r["priority"] as Priority,
  labels: (r["labels"] as string[] | null) ?? [],
  dueOn: (r["due_on"] as string | null) ?? null,
  description: (r["description"] as string | null) ?? null,
  version: r["version"] as number,
  updatedAt: Number(r["updated_at"]),
});

const toMember = (r: Record<string, unknown>): Member => ({
  id: r["id"] as string,
  name: r["name"] as string,
  title: (r["title"] as string | null) ?? null,
  email: (r["email"] as string | null) ?? null,
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

  async issues(projectId: string, filter: IssueFilter, first: number, after: string | null): Promise<{ items: Issue[]; total: number }> {
    const where = `project_id = $1
      and ($2::text is null or state = $2)
      and ($3::text is null or assignee_id = $3)
      and ($4::text is null or $4 = any(labels))`;
    const args = [projectId, filter.state ?? null, filter.assigneeId ?? null, filter.label ?? null];
    const { rows } = await this.sql.query(`select * from issues where ${where} and ($5::text is null or id > $5) order by id limit $6`, [...args, after, first]);
    const { rows: n } = await this.sql.query(`select count(*)::int as n from issues where ${where}`, args);
    return { items: rows.map(toIssue), total: (n[0]?.["n"] as number) ?? 0 };
  }

  /** Every person with what they hold, across projects; a person holding nothing still appears, with zeros. */
  async workload(today: string): Promise<Workload[]> {
    const { rows } = await this.sql.query(
      `select m.*,
         count(i.id) filter (where i.state = 'open')::int as open,
         count(i.id) filter (where i.state = 'doing')::int as doing,
         count(i.id) filter (where i.state = 'done')::int as done,
         count(i.id) filter (where i.state <> 'done' and i.due_on is not null and i.due_on < $1)::int as overdue
       from members m left join issues i on i.assignee_id = m.id
       group by m.id order by m.name`,
      [today],
    );
    return rows.map((r) => ({ member: toMember(r), open: r["open"] as number, doing: r["doing"] as number, done: r["done"] as number, overdue: r["overdue"] as number }));
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

  /** Who asked for a sign-off, as the feed recorded it when the request was heard: the requester's id is the line's by_id. */
  async approvalRequesterOf(approvalId: string): Promise<string | null> {
    const { rows } = await this.sql.query("select by_id from activity where id = $1", [`approvals:${approvalId}:asked`]);
    return (rows[0]?.["by_id"] as string | null) ?? null;
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
    return rows.map(toMember);
  }

  async membersByIds(ids: string[]): Promise<Map<string, Member>> {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return new Map();
    const { rows } = await this.sql.query("select * from members where id = any($1::text[])", [wanted]);
    return new Map(rows.map((r) => [r["id"] as string, toMember(r)]));
  }

  async createIssue(issue: Issue): Promise<void> {
    await this.sql.query(
      "insert into issues (id, project_id, title, state, assignee_id, priority, labels, due_on, description, version, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [issue.id, issue.projectId, issue.title, issue.state, issue.assigneeId, issue.priority, issue.labels, issue.dueOn, issue.description, issue.version, issue.updatedAt],
    );
  }

  /**
   * Writes only the columns the changes name, and only while the version is what the caller read. Two people
   * editing different fields at the same time both land in turn; the same field at the same time, the second is
   * told, because the version moved under them.
   */
  async updateIssue(id: string, changes: IssueChanges, fromVersion: number, at: number): Promise<boolean> {
    const columns: Record<keyof IssueChanges, string> = { title: "title", description: "description", priority: "priority", labels: "labels", dueOn: "due_on" };
    const sets: string[] = [];
    const args: unknown[] = [id, at, fromVersion];
    for (const key of Object.keys(columns) as Array<keyof IssueChanges>) {
      if (!(key in changes)) continue;
      args.push(changes[key]);
      sets.push(`${columns[key]} = $${args.length}`);
    }
    const { rowCount } = await this.sql.query(`update issues set ${[...sets, "version = version + 1", "updated_at = $2"].join(", ")} where id = $1 and version = $3`, args);
    return !!rowCount;
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
