/**
 * The workspace service.
 *
 * The part worth reading is `onStart`. Everything else is one service serving its own schema; that hook is where it
 * hears the rest of the fleet — an event the documents service raised reaches here over the relay, becomes a line
 * on the project's feed, and wakes the live queries and streams watching it. No polling, no webhook to register,
 * and no table shared between the two services.
 */
import { personOf, schemaAt, startService, type Deps } from "@apps/service-kit";
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

    // raised by the documents service, delivered here by the relay. the bus delivers by name, so hearing another
    // service's event costs one subscription and no coupling beyond agreeing what the event is called.
    server.events.on("DocumentChanged", (payload) => {
      // the event carries the project, so this service never asks the other which one: that is the whole of what
      // one service knows about another, and it is enough
      const { documentId, projectId, name, version, byId } = payload as { documentId: string; projectId: string; name: string; version: number; byId: string };
      const line = {
        // derived from what caused it, not random: this event reaches every instance of this service, and they
        // must write one row between them rather than one each
        id: `documents:${documentId}:${version}`,
        projectId,
        source: "documents",
        kind: version === 1 ? "document.added" : "document.replaced",
        // the name is what a person reads; the id stays at the end for anyone tracing it
        text: version === 1 ? `${name} (${documentId})` : `${name}, now version ${version} (${documentId})`,
        at: Date.now(),
        // the same person in both services: the fleet has one roster
        byId: byId ?? null,
      };

      void store
        .record(line)
        .then((written) => {
          if (written) deps.platform.log.info("recorded what the documents service did", { documentId, projectId, version, kind: line.kind });
          // delivered locally on every instance, written by only one: each instance has its own connected clients,
          // and each has to wake its own. `deliver` rather than `publish` for the same reason the id is derived —
          // this event is already on the relay, and sending anything back would multiply it by the fleet.
          server.events.deliver("ActivityHappened", { projectId: line.projectId, source: line.source, kind: line.kind, text: line.text, byId: line.byId });
          server.changes.deliver({ keys: new Set(), ops: new Set(["activity"]) });
        })
        .catch((e: unknown) => deps.platform.log.error("could not record a document change", { documentId, error: e instanceof Error ? e.message : String(e) }));
    });

    // NEEDS THE RAYFOLD CONSOLE: this queue is the console's — a separate commercial product in a private
    // repository, not yet on sale. Without CONSOLE_URL the "made searchable" lines never reach the feed; everything
    // else on it does.
    //
    // the last step of the document-kept flow, worked here because the feed is this service's: the platform hands
    // it what the steps before produced, so it can say whether the file became searchable or had nothing to index
    void deps.platform.defineQueue("notify-workspace", { maxAttempts: 3, leaseMs: 15_000 });
    deps.platform.work<{ documentId: string; projectId: string; name: string; version: number; results: { index: { indexed: boolean } | null } }>(
      "notify-workspace",
      async ({ payload: job }) => {
        const indexed = job.results.index?.indexed === true;
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
