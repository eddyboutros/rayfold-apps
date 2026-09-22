/**
 * The documents service: a Rayfold endpoint, an upload route, and the bytes it keeps.
 *
 *   POST /rayfold/uploads   bytes arrive, streamed to a file
 *   POST /rayfold           a command names the upload; the answer carries `url`
 *   GET  /files/{id}        where that url points, for a browser or another service
 */
import { FileUploadStore, personOf, schemaAt, startService, type Deps } from "@apps/service-kit";
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
function whoIs(req: IncomingMessage, query: URLSearchParams, deps: Deps): Viewer | null {
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = [bearer, query.get("token")].find((t) => t?.startsWith("rfcap1."));
  if (token) {
    try {
      return deps.caps.viewerOf(token) as Viewer;
    } catch {
      return null;
    }
  }
  const person = personOf(req);
  return person ? { id: person.id, name: person.name } : null;
}

/** The rule the schema states for Document, applied to its bytes: the team reads everything, a share reads its one. */
const mayRead = (viewer: Viewer, documentId: string): boolean => viewer.documentId === undefined || viewer.documentId === documentId;

const service = await startService({
  name: "documents",
  schema: schemaAt(new URL("./documents.rayfold", import.meta.url)),
  migrate: async (sql) => new DocumentStore(sql).migrate(),
  uploads: () => uploads,
  resolvers: (deps) =>
    resolvers({
      store: new DocumentStore(deps.sql),
      files,
      uploads,
      caps: deps.caps,
      platform: deps.platform,
      log: deps.platform.log,
      selfUrl: deps.config.selfUrl,
      // set in the console under documents / <environment> / uploads.maxBytes; this is the default until it is
      limitBytes: () => deps.platform.config.number("uploads.maxBytes", 25 * 1024 * 1024),
    }),
  viewer: (req, deps) => whoIs(req, new URLSearchParams((req.url ?? "").split("?")[1] ?? ""), deps),

  routes: (req: IncomingMessage, res: ServerResponse, deps: Deps) => {
    const [path = "", search = ""] = (req.url ?? "").split("?");
    if (req.method !== "GET" || !path.startsWith("/files/")) return false;
    void serve(decodeURIComponent(path.slice("/files/".length)), new URLSearchParams(search));
    return true;

    async function serve(revisionId: string, query: URLSearchParams): Promise<void> {
      // the same rule the schema states, applied to the bytes: an unguessable url is not a permission
      const found = await new DocumentStore(deps.sql).revisionWithDocument(revisionId);
      const viewer = whoIs(req, query, deps);
      const allowed = !!found && !!viewer && mayRead(viewer, found.document.id);
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
