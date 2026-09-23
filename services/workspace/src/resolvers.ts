/**
 * What the workspace service does.
 *
 * The feed is the interesting part. A command here records a line and publishes `ActivityHappened`; the stream
 * carries it, and a `live` query on `activity` re-runs because the command's patches invalidated it. The same two
 * things happen when another service raises an event — see `main.ts` — so the feed is the fleet's, not this
 * service's, and nothing here reads another service's tables to build it.
 */
import { RayfoldError, ok, type Capabilities, type Resolvers } from "@rayfold/server";
import type { Activity, Attachment, Comment, Issue, IssueChanges, IssueState, Member, Message, Notification, Priority, Project, ProjectChanges, WorkspaceStore } from "./store.ts";

export interface Viewer {
  id: string;
  name?: string;
  /** Set on the viewer an agent's token speaks for: the person's program, not the person. */
  agent?: boolean;
}

export interface Parts {
  store: WorkspaceStore;
  /** Mints agent tokens; without it the command is refused as unimplemented. */
  caps?: Capabilities;
  id?: () => string;
  now?: () => number;
}

/** One line for the feed, as a command raises it. `main.ts` builds the same shape from a relayed event. */
export interface Line {
  projectId: string;
  source: string;
  kind: string;
  text: string;
  /** Who did it; null for a line no person caused. */
  byId: string | null;
}

/** Labels as the project sees them: trimmed, lower-cased, no blanks, each once. */
const tidy = (labels: string[]): string[] => [...new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean))];

/** One change as the feed says it, so a line reads "priority high, due 2026-10-02" rather than a diff. */
function describeChange(key: keyof IssueChanges, next: Issue): string {
  switch (key) {
    case "title":
      return "renamed";
    case "description":
      return next.description ? "description" : "description cleared";
    case "priority":
      return `priority ${next.priority}`;
    case "labels":
      return next.labels.length ? `labels ${next.labels.join(" ")}` : "labels cleared";
    case "dueOn":
      return next.dueOn ? `due ${next.dueOn}` : "due day cleared";
  }
}

export function resolvers({ store, caps, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  const find = async (issueId: string): Promise<Issue> => {
    const issue = await store.issue(issueId);
    if (!issue) throw RayfoldError.domain("NotFound", { id: issueId }, `No issue ${issueId}`);
    return issue;
  };

  const pageOf = <T>(items: T[], total: number, cursor: (t: T) => string) => ({
    items,
    total,
    hasMore: items.length > 0 && total > items.length,
    cursor: items.length ? cursor(items[items.length - 1]!) : null,
  });

  /** Records a line and returns the event that announces it, for a command to emit. */
  const line = async (entry: Line): Promise<{ event: string; payload: Record<string, unknown> }> => {
    await store.record({ id: id(), at: now(), ...entry });
    return { event: "ActivityHappened", payload: { ...entry } };
  };

  /**
   * What a command that wrote a feed line hands back beside its result. A new row touches no entity a live
   * `activity` query has already read, so the patch names the operation itself: every open feed re-runs. The
   * workload is a count over issues, which no entity in its result names either, so it is re-run the same way.
   */
  const feedChanged = [{ invOp: ["activity", "workload"] }];

  /** Today as the day an issue's `dueOn` is compared with: a date, not an instant, so a due day is the whole day. */
  const today = () => new Date(now()).toISOString().slice(0, 10);

  /** The one line every command writes: what happened, on which project, by the person calling. */
  const did = (ctx: { viewer: unknown }, projectId: string, kind: string, text: string) =>
    line({ projectId, source: "workspace", kind, text, byId: (ctx.viewer as Viewer).id });

  /**
   * Tells one person something happened to them, and answers the event that carries it to their open screen. The id
   * is derived from the cause, so the same cause reaching two instances writes one notification.
   */
  const tell = async (recipientId: string, cause: string, n: Omit<Notification, "id" | "recipientId" | "at" | "readAt">): Promise<{ event: string; payload: Record<string, unknown> }> => {
    const notification: Notification = { id: `${cause}:${recipientId}`, recipientId, at: now(), readAt: null, ...n };
    await store.notify(notification);
    return { event: "Notified", payload: { recipientId, notificationId: notification.id, kind: n.kind, text: n.text, projectId: n.projectId, issueId: n.issueId, at: notification.at } };
  };

  /** What a command that wrote a notification hands back beside its result, so an open badge re-counts. */
  const unreadChanged = [{ invOp: ["unread", "notifications"] }];

  return {
    Query: {
      members: () => store.members(),

      me: async (_: unknown, ctx) => (await store.membersByIds([(ctx.viewer as Viewer).id])).get((ctx.viewer as Viewer).id) ?? null,

      projects: () => store.projects(),
      project: ({ id: projectId }: { id: string }) => store.project(projectId),

      issue: ({ id: issueId }: { id: string }) => store.issue(issueId),

      issues: async ({ projectId, state, assigneeId, label, page }: { projectId: string; state?: IssueState | null; assigneeId?: string | null; label?: string | null; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.issues(projectId, { state: state ?? null, assigneeId: assigneeId ?? null, label: label ?? null }, page.first, page.after ?? null);
        return pageOf(items, total, (i) => i.id);
      },

      workload: () => store.workload(today()),

      comments: async ({ issueId, page }: { issueId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.comments(issueId, page.first, page.after ?? null);
        return pageOf(items, total, (c) => c.id);
      },

      activity: async ({ projectId, page }: { projectId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.activity(projectId, page.first, page.after ?? null);
        return pageOf(items, total, (a) => a.id);
      },

      messages: async ({ projectId, page }: { projectId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.messages(projectId, page.first, page.after ?? null);
        // the cursor is the oldest shown: the next page is what came before it
        return pageOf(items, total, (m) => m.id);
      },

      notifications: async ({ page }: { page: { first: number; after?: string | null } }, ctx) => {
        const { items, total } = await store.notifications((ctx.viewer as Viewer).id, page.first, page.after ?? null);
        return pageOf(items, total, (n) => n.id);
      },

      unread: (_: unknown, ctx) => store.unread((ctx.viewer as Viewer).id),
    },

    Command: {
      createIssue: async (
        { projectId, title, assigneeId, priority, labels, dueOn, description }: { projectId: string; title: string; assigneeId?: string | null; priority: Priority; labels: string[]; dueOn?: string | null; description?: string | null },
        ctx,
      ) => {
        // named nobody: the project's default assignee takes it, when the project has one. named null on purpose, or
        // named someone, is kept as it is
        const fallback = assigneeId === undefined ? ((await store.project(projectId))?.defaultAssigneeId ?? null) : null;
        const issue: Issue = {
          id: id(),
          projectId,
          title,
          state: "open",
          assigneeId: assigneeId ?? fallback,
          priority,
          labels: tidy(labels),
          dueOn: dueOn ?? null,
          description: description ?? null,
          version: 1,
          updatedAt: now(),
        };
        // a dry run answers with the issue as it would be, and writes neither it nor its feed line
        if (ctx.simulate) return ok(issue);
        await store.createIssue(issue);
        return ok(issue, { patch: feedChanged, emit: [await did(ctx, projectId, "issue.created", title)] });
      },

      updateProject: async ({ id: projectId, changes }: { id: string; changes: ProjectChanges }, ctx) => {
        const project = await store.project(projectId);
        if (!project) throw RayfoldError.domain("NotFound", { id: projectId }, `No project ${projectId}`);
        ctx.checkVersion(`Project:${project.id}`, project.version, project);
        const applied: ProjectChanges = {};
        const sent = (key: keyof ProjectChanges) => key in changes && changes[key] !== undefined;
        if (sent("name")) {
          if (changes.name === null || !changes.name!.trim()) throw new RayfoldError("invalid_argument", "updateProject().changes.name: a project needs a name");
          applied.name = changes.name!.trim();
        }
        if (sent("description")) applied.description = changes.description?.trim() || null;
        if (sent("color")) {
          if (changes.color === null) throw new RayfoldError("invalid_argument", "updateProject().changes.color: cannot be null");
          applied.color = changes.color!;
        }
        if (sent("defaultAssigneeId")) {
          const who = changes.defaultAssigneeId ?? null;
          if (who !== null && !(await store.membersByIds([who])).has(who)) throw new RayfoldError("invalid_argument", `updateProject().changes.defaultAssigneeId: nobody is ${who}`);
          applied.defaultAssigneeId = who;
        }
        const next: Project = { ...project, ...applied, version: project.version + 1, updatedAt: now() };
        const won = await store.updateProject(project.id, applied, project.version, next.updatedAt);
        if (!won) {
          const current = await store.project(projectId);
          if (current) ctx.checkVersion(`Project:${project.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: projectId }, `Project ${projectId} changed while this was running`);
        }
        const said = (Object.keys(applied) as Array<keyof ProjectChanges>).map((k) => ({ name: "renamed", description: "description", color: `colour ${next.color}`, defaultAssigneeId: "default assignee" })[k]);
        // every open list of projects re-runs by the patch on this one; the rail, which reads the REST route, is told by the page
        return ok(next, { patch: feedChanged, emit: [await did(ctx, project.id, "project.edited", `${next.name}: ${said.join(", ") || "nothing"}`)] });
      },

      updateIssue: async ({ id: issueId, changes }: { id: string; changes: IssueChanges }, ctx) => {
        const issue = await find(issueId);
        ctx.checkVersion(`Issue:${issue.id}`, issue.version, issue);
        // only what was sent: an absent field is not a field set to nothing (spec 03 section 2)
        const applied: IssueChanges = {};
        const sent = (key: keyof IssueChanges) => key in changes && changes[key] !== undefined;
        const never = (key: keyof IssueChanges) => {
          if (changes[key] === null) throw new RayfoldError("invalid_argument", `updateIssue().changes.${key}: cannot be null`);
        };
        if (sent("title")) {
          never("title");
          applied.title = changes.title!;
        }
        if (sent("description")) applied.description = changes.description?.trim() || null;
        if (sent("priority")) {
          never("priority");
          applied.priority = changes.priority!;
        }
        if (sent("labels")) {
          never("labels");
          applied.labels = tidy(changes.labels!);
        }
        if (sent("dueOn")) applied.dueOn = changes.dueOn ?? null;
        const next: Issue = { ...issue, ...applied, version: issue.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);

        const won = await store.updateIssue(issue.id, applied, issue.version, next.updatedAt);
        if (!won) {
          const current = await find(issueId);
          ctx.checkVersion(`Issue:${issue.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: issueId }, `Issue ${issueId} changed while this was running`);
        }
        const what = Object.keys(applied).map((k) => describeChange(k as keyof IssueChanges, next)).join(", ");
        return ok(next, { patch: feedChanged, emit: [await did(ctx, issue.projectId, "issue.edited", `${next.title}: ${what || "nothing"}`)] });
      },

      assignIssue: async ({ id: issueId, assigneeId }: { id: string; assigneeId?: string | null }, ctx) => {
        const issue = await find(issueId);
        ctx.checkVersion(`Issue:${issue.id}`, issue.version, issue);
        const to = assigneeId ?? null;
        const next = { ...issue, assigneeId: to, version: issue.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);

        const won = await store.assignIssue(issue.id, to, issue.version, next.updatedAt);
        if (!won) {
          const current = await find(issueId);
          ctx.checkVersion(`Issue:${issue.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: issueId }, `Issue ${issueId} changed while this was running`);
        }
        const who = to ? ((await store.membersByIds([to])).get(to)?.name ?? to) : "nobody";
        const viewer = ctx.viewer as Viewer;
        const emit = [await did(ctx, issue.projectId, "issue.assigned", `${issue.title}: ${who}`)];
        // the person it was handed to is told, unless they handed it to themselves
        const told = to !== null && to !== viewer.id;
        if (told) {
          emit.push(await tell(to, `issue:${issue.id}:v${next.version}`, { kind: "issue.assigned", text: `${viewer.name ?? "Someone"} handed you ${issue.title}`, projectId: issue.projectId, issueId: issue.id }));
        }
        return ok(next, { patch: [...feedChanged, ...(told ? unreadChanged : [])], emit });
      },

      moveIssue: async ({ id: issueId, to }: { id: string; to: IssueState }, ctx) => {
        const issue = await find(issueId);
        ctx.checkVersion(`Issue:${issue.id}`, issue.version, issue);
        const next = { ...issue, state: to, version: issue.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);

        const won = await store.moveIssue(issue.id, to, issue.version, next.updatedAt);
        if (!won) {
          // someone moved it between the read and the write; tell the caller what it is now rather than overwriting
          const current = await find(issueId);
          ctx.checkVersion(`Issue:${issue.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: issueId }, `Issue ${issueId} changed while this was running`);
        }
        return ok(next, {
          patch: feedChanged,
          emit: [
            { event: "IssueMoved", payload: { issueId: issue.id, from: issue.state, to } },
            await did(ctx, issue.projectId, "issue.moved", `${issue.title}: ${issue.state} → ${to}`),
          ],
        });
      },

      addComment: async ({ issueId, body }: { issueId: string; body: string }, ctx) => {
        const issue = await find(issueId);
        const viewer = ctx.viewer as Viewer;
        const comment: Comment = { id: id(), issueId, body, at: now(), byId: viewer.id };
        await store.addComment(comment);
        const emit = [
          { event: "CommentAdded", payload: { issueId, commentId: comment.id } },
          await did(ctx, issue.projectId, "comment.added", `${issue.title}: ${body.slice(0, 80)}`),
        ];
        // whoever holds the issue hears about a reply on it, unless the reply is their own
        const holder = issue.assigneeId !== null && issue.assigneeId !== viewer.id ? issue.assigneeId : null;
        if (holder) {
          emit.push(await tell(holder, `comment:${comment.id}`, { kind: "comment.added", text: `${viewer.name ?? "Someone"} replied on ${issue.title}: ${body.slice(0, 60)}`, projectId: issue.projectId, issueId: issue.id }));
        }
        return ok(comment, {
          // the feed, and the badge. an open thread re-runs on its own: this patch sets a Comment, and Comment is
          // the type the thread returns, which is the conservative rule the protocol applies (spec 08 section 2)
          patch: [...feedChanged, ...(holder ? unreadChanged : [])],
          emit,
        });
      },

      attachDocument: async ({ issueId, documentId, name, url }: { issueId: string; documentId: string; name: string; url: string }, ctx) => {
        const issue = await find(issueId);
        const viewer = ctx.viewer as Viewer;
        const { pin, inserted } = await store.attach({ id: id(), issueId, documentId, name, url, at: now(), byId: viewer.id });
        // pinning twice is once: the row already there, and no second line on the feed
        if (!inserted) return ok(pin);
        // the issue's attachments changed under every open list: the patch names the issue, whose type the lists return
        return ok(pin, { patch: [{ inv: [`Issue:${issueId}`] }, ...feedChanged], emit: [await did(ctx, issue.projectId, "document.attached", `${issue.title}: ${name}`)] });
      },

      detachDocument: async ({ id: attachmentId }: { id: string }, ctx) => {
        const gone = await store.detach(attachmentId);
        if (!gone) return ok(null);
        const issue = await find(gone.issueId);
        // no `del` of the pin: the answer is that very entity, and a client that deleted it would answer null
        return ok(gone, { patch: [{ inv: [`Issue:${gone.issueId}`] }, ...feedChanged], emit: [await did(ctx, issue.projectId, "document.detached", `${issue.title}: ${gone.name}`)] });
      },

      say: async ({ projectId, body }: { projectId: string; body: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const message: Message = { id: id(), projectId, body, at: now(), byId: viewer.id };
        await store.say(message);
        // a new Message: every open history of this project re-runs by the type rule; the stream carries the line
        return ok(message, { emit: [{ event: "Said", payload: { projectId, messageId: message.id, body, byId: viewer.id, byName: viewer.name ?? viewer.id, at: message.at } }] });
      },

      mintAgentToken: ({ ops, ttlMs }: { ops: string[]; ttlMs: number }, ctx) => {
        if (!caps) throw new RayfoldError("unimplemented", "This service mints no tokens");
        const viewer = ctx.viewer as Viewer;
        // the same person, marked: policies that read viewer.agent tell a program from the person it acts for
        const token = caps.mint({ id: viewer.id, name: viewer.name, agent: true }, { ops, ttlMs, iss: "workspace" });
        return ok({ token, expiresAt: now() + ttlMs, ops });
      },

      markRead: async ({ upTo }: { upTo: string }, ctx) => {
        // an Instant argument arrives as RFC 3339 text; the store keeps epoch milliseconds
        const n = await store.markRead((ctx.viewer as Viewer).id, Date.parse(upTo), now());
        return ok(n, { patch: n ? unreadChanged : [] });
      },
    },

    Stream: {
      /** Every line on this project as it lands, whichever service caused it. */
      activityFeed: ({ projectId }: { projectId: string }, ctx) => {
        const source = ctx.events.subscribe<{ projectId: string }>("ActivityHappened", ctx.signal);
        return (async function* () {
          for await (const happened of source) if (happened.projectId === projectId) yield happened;
        })();
      },

      /** Each message in this project's chat, as it is said. */
      chat: ({ projectId }: { projectId: string }, ctx) => {
        const source = ctx.events.subscribe<{ projectId: string }>("Said", ctx.signal);
        return (async function* () {
          for await (const said of source) if (said.projectId === projectId) yield said;
        })();
      },

      /** Each notification for the caller, as it is written: the event carries the recipient, and this is the filter. */
      notified: (_: unknown, ctx) => {
        const me = (ctx.viewer as Viewer).id;
        const source = ctx.events.subscribe<{ recipientId: string }>("Notified", ctx.signal);
        return (async function* () {
          for await (const n of source) if (n.recipientId === me) yield n;
        })();
      },
    },

    Message: {
      by: async (messages: Message[]) => {
        const members = await store.membersByIds([...new Set(messages.map((m) => m.byId))]);
        return messages.map((m) => members.get(m.byId) ?? null);
      },
    },

    Project: {
      defaultAssignee: async (projects: Project[]) => {
        const members = await store.membersByIds([...new Set(projects.map((p) => p.defaultAssigneeId).filter((x): x is string => !!x))]);
        return projects.map((p) => (p.defaultAssigneeId ? (members.get(p.defaultAssigneeId) ?? null) : null));
      },
    },

    Issue: {
      assignee: async (issues: Issue[]) => {
        const members = await store.membersByIds([...new Set(issues.map((i) => i.assigneeId).filter((x): x is string => !!x))]);
        return issues.map((i) => (i.assigneeId ? (members.get(i.assigneeId) ?? null) : null));
      },
      // one read for the page: a batch loader over every issue's id, the way `assignee` is. a live list's re-runs load
      // it again (Rayfold 0.2.1), so a pin made under an open list reaches it
      attachments: async (issues: Issue[]) => {
        const pins = await store.attachmentsOf(issues.map((i) => i.id));
        return issues.map((i) => pins.get(i.id) ?? []);
      },
      // one read per issue on the page: a thread is its own list, and the field is lazy so a list of issues never pays for it
      comments: async (issues: Issue[], { page }: { page: { first: number; after?: string | null } }) =>
        Promise.all(
          issues.map(async (i) => {
            const { items, total } = await store.comments(i.id, page.first, page.after ?? null);
            return pageOf(items, total, (c) => c.id);
          }),
        ),
    },

    Attachment: {
      by: async (pins: Attachment[]) => {
        const members = await store.membersByIds([...new Set(pins.map((p) => p.byId))]);
        return pins.map((p) => members.get(p.byId) ?? null);
      },
    },

    Comment: {
      by: async (comments: Comment[]) => {
        const members = await store.membersByIds([...new Set(comments.map((c) => c.byId))]);
        return comments.map((c) => members.get(c.byId) ?? null);
      },
    },

    Activity: {
      by: async (lines: Activity[]) => {
        const members = await store.membersByIds([...new Set(lines.map((l) => l.byId).filter((x): x is string => !!x))]);
        return lines.map((l) => (l.byId ? (members.get(l.byId) ?? null) : null));
      },
    },
  } satisfies Resolvers as Resolvers;
}

export type { Activity, Attachment, Comment, Issue, Member, Message, Notification };
