/**
 * The documents service: a Rayfold endpoint, an upload route, and the bytes it keeps.
 *
 *   POST /rayfold/uploads   bytes arrive, streamed to a file
 *   POST /rayfold           a command names the upload; the answer carries `url`
 *   GET  /files/{id}        where that url points, for a browser or another service
 */
import { FileUploadStore, schemaAt, startService, type Deps } from "@apps/service-kit";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { FileStore } from "./files.ts";
import { DocumentStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";

const FILES_DIR = process.env["FILES_DIR"] ?? "/var/lib/documents/files";
const UPLOADS_DIR = process.env["UPLOADS_DIR"] ?? "/var/lib/documents/uploads";
/** Where this service is reached from outside, so a URL it hands out works for whoever gets it. */
const PUBLIC_BASE = process.env["PUBLIC_BASE"] ?? "/files";

const files = new FileStore(FILES_DIR, PUBLIC_BASE);
const uploads = new FileUploadStore({ dir: UPLOADS_DIR });

/** A signed-in person, or the viewer a share's token speaks for. A bad token is nobody, not an error. */
function whoIs(authorization: string | undefined, query: URLSearchParams, deps: Deps): Viewer | null {
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = [bearer, query.get("token")].find((t) => t?.startsWith("rfcap1."));
  if (token) {
    try {
      return deps.caps.viewerOf(token) as Viewer;
    } catch {
      return null;
    }
  }
  // stands in for whatever the fleet uses: a session cookie, a JWT from the gateway, an introspected token
  if (authorization === "Bearer ada") return { id: "u1", name: "Ada" };
  if (authorization === "Bearer grace") return { id: "u2", name: "Grace" };
  return null;
}

const service = await startService({
  name: "documents",
  schema: schemaAt(new URL("./documents.rayfold", import.meta.url)),
  migrate: async (sql) => new DocumentStore(sql).migrate(),
  uploads: () => uploads,
  resolvers: (deps) => resolvers({ store: new DocumentStore(deps.sql), files, uploads, caps: deps.caps }),
  viewer: (req, deps) => whoIs(req.headers.authorization, new URLSearchParams((req.url ?? "").split("?")[1] ?? ""), deps),

  routes: (req: IncomingMessage, res: ServerResponse, deps: Deps) => {
    const [path = "", search = ""] = (req.url ?? "").split("?");
    if (req.method !== "GET" || !path.startsWith("/files/")) return false;
    void serve(decodeURIComponent(path.slice("/files/".length)), new URLSearchParams(search));
    return true;

    async function serve(revisionId: string, query: URLSearchParams): Promise<void> {
      // the same rule the schema states, applied to the bytes: an unguessable url is not a permission
      const found = await new DocumentStore(deps.sql).revisionWithDocument(revisionId);
      const viewer = whoIs(req.headers.authorization, query, deps);
      const allowed = !!found && !!viewer && (found.document.ownerId === viewer.id || viewer.documentId === found.document.id);
      if (!allowed) return void res.writeHead(found && !viewer ? 401 : 404).end();

      // asked before the status line goes out: a stream that fails afterwards can only close the connection, which
      // a client cannot tell from a network fault
      if (!(await files.has(revisionId))) return void res.writeHead(404).end();
      const bytes = files.read(revisionId);
      if (!bytes) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": found.document.contentType, "x-content-type-options": "nosniff" });
      Readable.fromWeb(bytes as Parameters<typeof Readable.fromWeb>[0])
        .on("error", () => res.destroy())
        .pipe(res);
    }
  },
});

console.log(`[documents] files in ${FILES_DIR}, uploads in ${UPLOADS_DIR}`);
export default service;
