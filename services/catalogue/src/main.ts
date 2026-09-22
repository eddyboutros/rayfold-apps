/**
 * The catalogue service: what the company sells, who works here, what has been written down, and what has been
 * kept as a file — behind one search.
 *
 * The files are the fleet's part. Keeping a document in the documents service puts an `extract-text` job on the
 * platform's queue; this service takes the job, fetches the bytes with the capability token the job carries, reads
 * the text and indexes it. No shared table, no call from one service to the other, and a worker that dies leaves a
 * job the next one takes. The console shows the queue moving.
 */
import { personOf, schemaAt, startService, type Deps } from "@apps/service-kit";
import { CatalogueStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";
import { textOf } from "./extract.ts";

function whoIs(req: Parameters<typeof personOf>[0]): Viewer | null {
  const person = personOf(req);
  return person ? { id: person.id, name: person.name } : null;
}

/** What the documents service puts on the queue; see its `ExtractJob`. */
interface ExtractJob {
  documentId: string;
  projectId: string;
  name: string;
  version: number;
  contentType: string;
  size: number;
  url: string;
  fetchUrl: string;
}

const service = await startService({
  name: "catalogue",
  schema: schemaAt(new URL("./catalogue.rayfold", import.meta.url)),
  migrate: async (sql) => new CatalogueStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new CatalogueStore(deps.sql) }),
  viewer: (req) => whoIs(req),

  onStart: async (server, deps: Deps) => {
    const store = new CatalogueStore(deps.sql);
    const { platform } = deps;
    // the queue's limits are this service's to state: it is the one that knows how long a file takes to read
    await platform.defineQueue("extract-text", { maxAttempts: 5, leaseMs: 60_000, backoffMs: 5_000 });
    platform.work<ExtractJob>("extract-text", async ({ payload: job }) => {
      const res = await fetch(job.fetchUrl);
      // gone is done: a document deleted before its job ran has nothing to index, and retrying will not bring it back
      if (res.status === 404) {
        await store.removeFile(job.documentId);
        return { indexed: false, reason: "the document is gone" };
      }
      if (!res.ok) throw new Error(`fetching the bytes answered ${res.status}`);
      const text = textOf(job.contentType, job.name, new Uint8Array(await res.arrayBuffer()));
      const kept = await store.indexFile({
        id: job.documentId,
        name: job.name,
        projectId: job.projectId,
        contentType: job.contentType,
        size: job.size,
        url: job.url,
        text,
        version: job.version,
        updatedAt: Date.now(),
      });
      // a File is an entity this service returns from live queries; nothing here is live yet, but a screen that
      // subscribes to `items` will hear this
      if (kept) server.changes.publish({ keys: new Set([`File:${job.documentId}`]), ops: new Set(["items", "search"]) });
      return { indexed: kept, characters: text.length };
    });
  },
});

export default service;
