/**
 * What the workspace service does.
 *
 * The feed is the interesting part. A command here records a line and publishes `ActivityHappened`; the stream
 * carries it, and a `live` query on `activity` re-runs because the command's patches invalidated it. The same two
 * things happen when another service raises an event — see `main.ts` — so the feed is the fleet's, not this
 * service's, and nothing here reads another service's tables to build it.
 */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server";
import type { Activity, Comment, Issue, IssueState, Member, WorkspaceStore } from "./store.ts";

export interface Viewer {
  id: string;
  name?: string;
}

export interface Parts {
  store: WorkspaceStore;
  id?: () => string;
  now?: () => number;
}

/** One line for the feed, as a command raises it. `main.ts` builds the same shape from a relayed event. */
export interface Line {
  projectId: string;
  source: string;
  kind: string;
  text: string;
}

export function resolvers({ store, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
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
   * `activity` query has already read, so the patch names the operation itself: every open feed re-runs.
   */
  const feedChanged = [{ invOp: ["activity"] }];

  return {
    Query: {
      issue: ({ id: issueId }: { id: string }) => store.issue(issueId),

      issues: async ({ projectId, page }: { projectId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.issues(projectId, page.first, page.after ?? null);
        return pageOf(items, total, (i) => i.id);
      },

      comments: async ({ issueId, page }: { issueId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.comments(issueId, page.first, page.after ?? null);
        return pageOf(items, total, (c) => c.id);
      },

      activity: async ({ projectId, page }: { projectId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.activity(projectId, page.first, page.after ?? null);
        return pageOf(items, total, (a) => a.id);
      },
    },

    Command: {
      createIssue: async ({ projectId, title }: { projectId: string; title: string }, ctx) => {
        const issue: Issue = { id: id(), projectId, title, state: "open", assigneeId: (ctx.viewer as Viewer).id, version: 1, updatedAt: now() };
        await store.createIssue(issue);
        return ok(issue, { patch: feedChanged, emit: [await line({ projectId, source: "workspace", kind: "issue.created", text: title })] });
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
            await line({ projectId: issue.projectId, source: "workspace", kind: "issue.moved", text: `${issue.title}: ${issue.state} → ${to}` }),
          ],
        });
      },

      addComment: async ({ issueId, body }: { issueId: string; body: string }, ctx) => {
        const issue = await find(issueId);
        const comment: Comment = { id: id(), issueId, body, at: now(), byId: (ctx.viewer as Viewer).id };
        await store.addComment(comment);
        return ok(comment, {
          patch: feedChanged,
          emit: [
            { event: "CommentAdded", payload: { issueId, commentId: comment.id } },
            await line({ projectId: issue.projectId, source: "workspace", kind: "comment.added", text: `${issue.title}: ${body.slice(0, 80)}` }),
          ],
        });
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
    },

    Issue: {
      assignee: async (issues: Issue[]) => {
        const members = await store.membersByIds([...new Set(issues.map((i) => i.assigneeId).filter((x): x is string => !!x))]);
        return issues.map((i) => (i.assigneeId ? (members.get(i.assigneeId) ?? null) : null));
      },
    },

    Comment: {
      by: async (comments: Comment[]) => {
        const members = await store.membersByIds([...new Set(comments.map((c) => c.byId))]);
        return comments.map((c) => members.get(c.byId) ?? null);
      },
    },
  } satisfies Resolvers as Resolvers;
}

export type { Activity, Comment, Issue, Member };
