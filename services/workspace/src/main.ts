/**
 * The workspace service.
 *
 * The part worth reading is `onStart`. Everything else is one service serving its own schema; that hook is where it
 * hears the rest of the fleet — an event the documents service raised reaches here over the relay, becomes a line
 * on the project's feed, and wakes the live queries and streams watching it. No polling, no webhook to register,
 * and no table shared between the two services.
 */
import { schemaAt, startService, type Deps } from "@apps/service-kit";
import type { RayfoldServer } from "@rayfold/server";
import { WorkspaceStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";

/**
 * Which project a document belongs to.
 *
 * A real fleet asks the documents service, or carries the project on the event. This is the seam where that lookup
 * goes; a fixed answer keeps the example about the relay rather than about service discovery.
 */
const PROJECT_OF_DOCUMENTS = process.env["DOCUMENTS_PROJECT"] ?? "p1";

function whoIs(authorization: string | undefined): Viewer | null {
  if (authorization === "Bearer ada") return { id: "u1", name: "Ada" };
  if (authorization === "Bearer grace") return { id: "u2", name: "Grace" };
  return null;
}

const service = await startService({
  name: "workspace",
  schema: schemaAt(new URL("./workspace.rayfold", import.meta.url)),
  migrate: async (sql) => new WorkspaceStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new WorkspaceStore(deps.sql) }),
  viewer: (req) => whoIs(req.headers.authorization),

  onStart: (server: RayfoldServer, deps: Deps) => {
    const store = new WorkspaceStore(deps.sql);

    // raised by the documents service, delivered here by the relay. the bus delivers by name, so hearing another
    // service's event costs one subscription and no coupling beyond agreeing what the event is called.
    server.events.on("DocumentChanged", (payload) => {
      const { documentId, name, version } = payload as { documentId: string; name: string; version: number };
      const line = {
        // derived from what caused it, not random: this event reaches every instance of this service, and they
        // must write one row between them rather than one each
        id: `documents:${documentId}:${version}`,
        projectId: PROJECT_OF_DOCUMENTS,
        source: "documents",
        kind: version === 1 ? "document.added" : "document.replaced",
        // the name is what a person reads; the id stays at the end for anyone tracing it
        text: version === 1 ? `${name} (${documentId})` : `${name}, now version ${version} (${documentId})`,
        at: Date.now(),
      };

      void store
        .record(line)
        .then(() => {
          // delivered locally on every instance, written by only one: each instance has its own connected clients,
          // and each has to wake its own. `deliver` rather than `publish` for the same reason the id is derived —
          // this event is already on the relay, and sending anything back would multiply it by the fleet.
          server.events.deliver("ActivityHappened", { projectId: line.projectId, source: line.source, kind: line.kind, text: line.text });
          server.changes.deliver({ keys: new Set(), ops: new Set(["activity"]) });
        })
        .catch((e: unknown) => console.error("[workspace] could not record a document change", e));
    });
  },
});

export default service;
