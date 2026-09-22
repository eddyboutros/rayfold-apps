/**
 * The workspace service.
 *
 * The part worth reading is `onStart`. Everything else is one service serving its own schema; that hook is where it
 * hears the rest of the fleet — an event the documents service raised reaches here over the relay, becomes a line
 * on the project's feed, and wakes the live queries and streams watching it. No polling, no webhook to register,
 * and no table shared between the two services.
 */
import { TEAM, personOf, schemaAt, startService, type Deps } from "@apps/service-kit";
import type { RayfoldServer } from "@rayfold/server";
import { WorkspaceStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";

function whoIs(req: Parameters<typeof personOf>[0]): Viewer | null {
  const person = personOf(req);
  return person ? { id: person.id, name: person.name } : null;
}

const service = await startService({
  name: "workspace",
  schema: schemaAt(new URL("./workspace.rayfold", import.meta.url)),
  migrate: async (sql) => new WorkspaceStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new WorkspaceStore(deps.sql) }),
  viewer: (req) => whoIs(req),

  onStart: (server: RayfoldServer, deps: Deps) => {
    const store = new WorkspaceStore(deps.sql);

    /**
     * Records a line for something another service did, once per fleet however many instances hear it. The id is
     * derived from what caused it, not random: the event reaches every instance of this service, and they must write
     * one row between them rather than one each. Delivered locally on every instance, written by only one: each has
     * its own connected clients to wake. `deliver` rather than `publish` for the same reason the id is derived: the
     * event is already on the relay, and sending anything back would multiply it by the fleet.
     */
    const heard = (id: string, projectId: string, kind: string, text: string, byId: string | null, about: Record<string, unknown>, source = "documents") => {
      const line = { id, projectId, source, kind, text, at: Date.now(), byId };
      void store
        .record(line)
        .then((written) => {
          if (written) deps.platform.log.info("recorded what the documents service did", { ...about, kind });
          server.events.deliver("ActivityHappened", { projectId, source: line.source, kind, text, byId });
          server.changes.deliver({ keys: new Set(), ops: new Set(["activity"]) });
        })
        .catch((e: unknown) => deps.platform.log.error("could not record a document change", { ...about, error: e instanceof Error ? e.message : String(e) }));
    };

    // raised by the documents service, delivered here by the relay. the bus delivers by name, so hearing another
    // service's event costs one subscription and no coupling beyond agreeing what the event is called. the event
    // carries the project, so this service never asks the other which one: that is the whole of what one service
    // knows about another, and it is enough. the name is what a person reads; the id stays at the end for tracing.
    server.events.on("DocumentChanged", (payload) => {
      const { documentId, projectId, name, version, byId } = payload as { documentId: string; projectId: string; name: string; version: number; byId: string };
      heard(
        `documents:${documentId}:${version}`,
        projectId,
        version === 1 ? "document.added" : "document.replaced",
        version === 1 ? `${name} (${documentId})` : `${name}, now version ${version} (${documentId})`,
        // the same person in both services: the fleet has one roster
        byId ?? null,
        { documentId, projectId, version },
      );
    });
    server.events.on("DocumentFiled", (payload) => {
      const { documentId, projectId, name, folder, byId } = payload as { documentId: string; projectId: string; name: string; folder: string | null; byId: string };
      heard(`documents:${documentId}:filed:${folder ?? ""}:${Date.now()}`, projectId, "document.filed", `${name}: ${folder ?? "the root"} (${documentId})`, byId ?? null, { documentId, projectId, folder });
    });
    server.events.on("DocumentTagged", (payload) => {
      const { documentId, projectId, name, tags, byId } = payload as { documentId: string; projectId: string; name: string; tags: string[]; byId: string };
      heard(`documents:${documentId}:tagged:${tags.join(",")}`, projectId, "document.tagged", `${name}: ${tags.length ? tags.join(" ") : "no tags"} (${documentId})`, byId ?? null, { documentId, projectId, tags });
    });
    // raised by the approvals service, in Kotlin, on another port: the same relay, the same shape of line. the person
    // asked is told through the bell, and the one who asked hears the decision the same way
    server.events.on("ApprovalRequested", (payload) => {
      const { approvalId, documentId, projectId, documentName, requesterId, approverId } = payload as { approvalId: string; documentId: string; projectId: string; documentName: string; requesterId: string; approverId: string };
      const who = Object.fromEntries(TEAM.map((p) => [p.id, p.name]));
      heard(`approvals:${approvalId}:asked`, projectId, "approval.requested", `${documentName}: ${who[approverId] ?? approverId} (${documentId})`, requesterId ?? null, { approvalId, projectId }, "approvals");
      void tellOnce({ id: `approval:${approvalId}:asked`, recipientId: approverId, kind: "approval.requested", text: `${who[requesterId] ?? "Someone"} asked you to sign off on ${documentName}`, projectId, issueId: null });
    });
    server.events.on("ApprovalDecided", (payload) => {
      const { approvalId, documentId, projectId, documentName, decision, byId, note } = payload as { approvalId: string; documentId: string; projectId: string; documentName: string; decision: string; byId: string; note: string | null };
      const who = Object.fromEntries(TEAM.map((p) => [p.id, p.name]));
      heard(`approvals:${approvalId}:${decision}`, projectId, "approval.decided", `${documentName}: ${decision}${note ? `, ${note}` : ""} (${documentId})`, byId ?? null, { approvalId, projectId, decision }, "approvals");
      // the one who asked hears the answer; a withdrawal is theirs already
      if (decision !== "withdrawn") {
        void store.approvalRequesterOf(approvalId).then((requesterId) => {
          if (requesterId && requesterId !== byId) {
            return tellOnce({ id: `approval:${approvalId}:${decision}`, recipientId: requesterId, kind: "approval.decided", text: `${who[byId] ?? "Someone"} ${decision} ${documentName}${note ? `: ${note}` : ""}`, projectId, issueId: null });
          }
          return undefined;
        });
      }
    });

    /** A notification written once for the fleet, and every open bell on this instance woken. */
    const tellOnce = async (n: { id: string; recipientId: string; kind: string; text: string; projectId: string; issueId: string | null }) => {
      const notification = { ...n, at: Date.now(), readAt: null };
      if (await store.notify(notification)) {
        server.events.deliver("Notified", { recipientId: n.recipientId, notificationId: n.id, kind: n.kind, text: n.text, projectId: n.projectId, issueId: n.issueId, at: notification.at });
        server.changes.deliver({ keys: new Set(), ops: new Set(["unread", "notifications"]) });
      }
    };

    server.events.on("DocumentNoted", (payload) => {
      const { documentId, projectId, name, excerpt, byId } = payload as { documentId: string; projectId: string; name: string; excerpt: string; byId: string };
      heard(`documents:${documentId}:noted:${byId}:${excerpt}`, projectId, "document.noted", `${name}: ${excerpt} (${documentId})`, byId ?? null, { documentId, projectId });
    });

    // NEEDS THE RAYFOLD CONSOLE: this queue is the console's — a separate commercial product in a private
    // repository, not yet on sale. Without CONSOLE_URL the "made searchable" lines never reach the feed; everything
    // else on it does.
    //
    // the last step of the document-kept flow, worked here because the feed is this service's: the platform hands
    // it what the steps before produced, so it can say whether the file became searchable or had nothing to index
    void deps.platform.defineQueue("notify-workspace", { maxAttempts: 3, leaseMs: 15_000 });
    deps.platform.work<{ documentId: string; projectId: string; name: string; version: number; byId?: string; results: { index: { indexed: boolean } | null } }>(
      "notify-workspace",
      async ({ payload: job }) => {
        const indexed = job.results.index?.indexed === true;
        // the person who kept the file is told it is searchable now: a notification from one service about another's work
        if (indexed && job.byId) {
          const notification = { id: `document:${job.documentId}:v${job.version}:indexed`, recipientId: job.byId, kind: "document.indexed", text: `${job.name} is searchable now`, projectId: job.projectId, issueId: null, at: Date.now(), readAt: null };
          if (await store.notify(notification)) {
            server.events.deliver("Notified", { recipientId: job.byId, notificationId: notification.id, kind: notification.kind, text: notification.text, projectId: job.projectId, issueId: null, at: notification.at });
            server.changes.deliver({ keys: new Set(), ops: new Set(["unread", "notifications"]) });
          }
        }
        const line = {
          id: `documents:${job.documentId}:${job.version}:indexed`,
          projectId: job.projectId,
          source: "catalogue",
          kind: indexed ? "document.indexed" : "document.empty",
          // the kind carries the verb; the text is the file, so the feed reads "found nothing to index in <name>"
          text: `${job.name} (${job.documentId})`,
          at: Date.now(),
          // no person did this: the platform did, which the feed shows as the product
          byId: null,
        };
        const written = await store.record(line);
        if (written) {
          server.events.deliver("ActivityHappened", { projectId: line.projectId, source: line.source, kind: line.kind, text: line.text, byId: null });
          server.changes.deliver({ keys: new Set(), ops: new Set(["activity"]) });
        }
        return { recorded: written };
      },
    );
  },
});

export default service;
