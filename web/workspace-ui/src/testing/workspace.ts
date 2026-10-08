/**
 * The workspace service's rules over arrays, for the specs: each command patches and emits what the service's own
 * resolver does (services/workspace/src/resolvers.ts), so a live list re-runs when the service's would.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";

export const T = "2026-03-04T12:00:00.000Z";
export const ADA = { id: "u1", name: "Ada Lovelace" };
export const GRACE = { id: "u2", name: "Grace Hopper" };
export const NOOR = { id: "u3", name: "Noor Haddad" };
export const MEMBERS = [ADA, GRACE, NOOR];

export interface IssueRow {
  $type: "Issue";
  id: string;
  projectId: string;
  title: string;
  state: "open" | "doing" | "done";
  assigneeId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  labels: string[];
  dueOn: string | null;
  description: string | null;
  version: number;
  updatedAt: string;
}

export interface PinRow {
  id: string;
  issueId: string;
  documentId: string;
  name: string;
  url: string;
  at: string;
  byId: string;
}

export interface Db {
  issues: IssueRow[];
  pins: PinRow[];
  comments: Array<{ id: string; issueId: string; body: string; at: string; byId: string }>;
  activity: Array<{ id: string; projectId: string; source: string; kind: string; subject: string; detail: string | null; at: string; byId: string | null }>;
  messages: Array<{ id: string; projectId: string; body: string; at: string; byId: string }>;
  notifications: Array<{ id: string; recipientId: string; kind: string; text: string; projectId: string; issueId: string | null; at: string; readAt: string | null }>;
  projects: Array<{ id: string; name: string; description: string | null; color: string; defaultAssigneeId: string | null; version: number; updatedAt: string }>;
  workload: Array<{ memberId: string; title: string | null; email: string | null; open: number; doing: number; done: number; overdue: number }>;
}

export const issue = (id: string, title: string, over: Partial<IssueRow> = {}): IssueRow => ({
  $type: "Issue",
  id,
  projectId: "p1",
  title,
  state: "open",
  assigneeId: null,
  priority: "normal",
  labels: [],
  dueOn: null,
  description: null,
  version: 1,
  updatedAt: T,
  ...over,
});

export function emptyDb(): Db {
  return { issues: [], pins: [], comments: [], activity: [], messages: [], notifications: [], projects: [], workload: [] };
}

const feedChanged = [{ invOp: ["activity", "workload"] }];
const unreadChanged = [{ invOp: ["unread", "notifications"] }];

export function workspaceResolvers(db: Db, gate: { failing?: string } = {}): Resolvers {
  let n = 0;
  const member = (id: string | null) => MEMBERS.find((m) => m.id === id) ?? null;
  const find = (id: string) => {
    const i = db.issues.find((x) => x.id === id);
    if (!i) throw RayfoldError.domain("NotFound", { id }, `No issue ${id}`);
    return i;
  };
  const page = <R>(items: R[]) => ({ items, total: items.length, hasMore: false, cursor: null });
  const viewerOf = (ctx: { viewer: unknown }) => ctx.viewer as { id: string; name: string };
  const refuse = () => {
    if (gate.failing) throw new RayfoldError("internal", gate.failing);
  };
  return {
    Query: {
      members: () => MEMBERS,
      me: (_: unknown, ctx) => member(viewerOf(ctx).id),
      project: ({ id }: { id: string }) => db.projects.find((p) => p.id === id) ?? null,
      projects: () => db.projects,
      // the whole team holds work, including someone the pickers in these specs never offer
      workload: () => db.workload.map((w) => ({ member: { ...(member(w.memberId) ?? { id: w.memberId, name: "Tomás Ferreira" }), title: w.title, email: w.email }, open: w.open, doing: w.doing, done: w.done, overdue: w.overdue })),
      issue: ({ id }: { id: string }) => db.issues.find((x) => x.id === id) ?? null,
      issues: ({ projectId, assigneeId, label }: { projectId: string; assigneeId?: string | null; label?: string | null }) =>
        page(db.issues.filter((i) => i.projectId === projectId && (!assigneeId || i.assigneeId === assigneeId) && (!label || i.labels.includes(label)))),
      comments: ({ issueId }: { issueId: string }) => page(db.comments.filter((c) => c.issueId === issueId)),
      activity: ({ projectId }: { projectId: string }) => {
        refuse();
        return page(db.activity.filter((a) => a.projectId === projectId));
      },
      messages: ({ projectId }: { projectId: string }) => page(db.messages.filter((m) => m.projectId === projectId)),
      notifications: (_: unknown, ctx) => page(db.notifications.filter((x) => x.recipientId === viewerOf(ctx).id)),
      unread: (_: unknown, ctx) => db.notifications.filter((x) => x.recipientId === viewerOf(ctx).id && x.readAt === null).length,
    },
    Command: {
      createIssue: ({ projectId, title }: { projectId: string; title: string }) => {
        if (title === "fail") throw new RayfoldError("invalid_argument", "That title is not allowed");
        const row = issue(`new${++n}`, title, { projectId });
        db.issues.push(row);
        return ok(row, { patch: [{ invOp: ["issues"] }, ...feedChanged] });
      },
      updateIssue: ({ id, changes }: { id: string; changes: Partial<IssueRow> }, ctx) => {
        const i = find(id);
        ctx.checkVersion(`Issue:${i.id}`, i.version, i);
        Object.assign(i, changes, { version: i.version + 1 });
        return ok(i, { patch: [{ invOp: ["issues"] }, ...feedChanged] });
      },
      assignIssue: ({ id, assigneeId }: { id: string; assigneeId?: string | null }, ctx) => {
        const i = find(id);
        ctx.checkVersion(`Issue:${i.id}`, i.version, i);
        Object.assign(i, { assigneeId: assigneeId ?? null, version: i.version + 1 });
        return ok(i, { patch: [{ invOp: ["issues"] }, ...feedChanged] });
      },
      moveIssue: ({ id, to }: { id: string; to: IssueRow["state"] }, ctx) => {
        const i = find(id);
        ctx.checkVersion(`Issue:${i.id}`, i.version, i);
        Object.assign(i, { state: to, version: i.version + 1 });
        return ok(i, { patch: feedChanged });
      },
      attachDocument: ({ issueId, documentId, name, url }: Omit<PinRow, "id" | "at" | "byId">, ctx) => {
        find(issueId);
        const pin = { id: `pin${++n}`, issueId, documentId, name, url, at: T, byId: viewerOf(ctx).id };
        db.pins.push(pin);
        return ok(pin, { patch: [{ inv: [`Issue:${issueId}`] }, ...feedChanged] });
      },
      detachDocument: ({ id }: { id: string }) => {
        const pin = db.pins.find((p) => p.id === id);
        if (!pin) return ok(null);
        db.pins.splice(db.pins.indexOf(pin), 1);
        return ok(pin, { patch: [{ inv: [`Issue:${pin.issueId}`] }, ...feedChanged] });
      },
      addComment: ({ issueId, body }: { issueId: string; body: string }, ctx) => {
        if (body === "fail") throw RayfoldError.domain("NotFound", { id: issueId }, "That issue is gone");
        const c = { id: `c${++n}`, issueId, body, at: T, byId: viewerOf(ctx).id };
        db.comments.push(c);
        return ok(c, { patch: [{ invOp: ["comments"] }, ...feedChanged] });
      },
      say: ({ projectId, body }: { projectId: string; body: string }, ctx) => {
        if (body === "fail") throw new RayfoldError("unavailable", "The chat is resting");
        const by = viewerOf(ctx);
        const m = { id: `m${++n}`, projectId, body, at: T, byId: by.id };
        db.messages.push(m);
        return ok(m, { emit: [{ event: "Said", payload: { projectId, messageId: m.id, body, byId: by.id, byName: by.name, at: T } }] });
      },
      markRead: ({ upTo }: { upTo: string }, ctx) => {
        let marked = 0;
        for (const x of db.notifications) if (x.recipientId === viewerOf(ctx).id && x.readAt === null && x.at <= upTo) (x.readAt = upTo), marked++;
        return ok(marked, { patch: marked ? unreadChanged : [] });
      },
      updateProject: ({ id, changes }: { id: string; changes: Record<string, unknown> }, ctx) => {
        const p = db.projects.find((x) => x.id === id);
        if (!p) throw RayfoldError.domain("NotFound", { id }, `No project ${id}`);
        ctx.checkVersion(`Project:${p.id}`, p.version, p);
        Object.assign(p, changes, { version: p.version + 1 });
        return ok(p, { patch: feedChanged });
      },
    },
    Stream: {
      chat: ({ projectId }: { projectId: string }, ctx) => {
        const source = ctx.events.subscribe<{ projectId: string }>("Said", ctx.signal);
        return (async function* () {
          for await (const said of source) if (said.projectId === projectId) yield said;
        })();
      },
      notified: (_: unknown, ctx) => {
        const me = viewerOf(ctx).id;
        const source = ctx.events.subscribe<{ recipientId: string }>("Notified", ctx.signal);
        return (async function* () {
          for await (const x of source) if (x.recipientId === me) yield x;
        })();
      },
      activityFeed: ({ projectId }: { projectId: string }, ctx) => {
        const source = ctx.events.subscribe<{ projectId: string }>("ActivityHappened", ctx.signal);
        return (async function* () {
          for await (const x of source) if (x.projectId === projectId) yield x;
        })();
      },
    },
    Issue: {
      assignee: (is: IssueRow[]) => is.map((i) => member(i.assigneeId)),
      attachments: (is: IssueRow[]) => is.map((i) => db.pins.filter((p) => p.issueId === i.id)),
    },
    Attachment: { by: (ps: PinRow[]) => ps.map((p) => member(p.byId)) },
    Comment: { by: (cs: Array<{ byId: string }>) => cs.map((c) => member(c.byId)) },
    Activity: { by: (as: Array<{ byId: string | null }>) => as.map((a) => member(a.byId)) },
    Message: { by: (ms: Array<{ byId: string }>) => ms.map((m) => member(m.byId)) },
    Project: { defaultAssignee: (ps: Array<{ defaultAssigneeId: string | null }>) => ps.map((p) => member(p.defaultAssigneeId)) },
  } as Resolvers;
}
