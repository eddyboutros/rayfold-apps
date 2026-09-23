/**
 * The catalogue service: what the company sells, who works here, what has been written down, and what has been
 * kept as a file — behind one search.
 *
 * The files are the fleet's part. Keeping a document in the documents service starts a flow on the platform, and
 * this service works its first two steps: `extract-text` fetches the bytes with the capability token the job
 * carries and reads the text; `index-file`, which the platform runs only when there was text, indexes it. No shared
 * table, no call from one service to the other, and a worker that dies leaves a job the next one takes. The console
 * shows the run moving from queue to queue.
 */
import { personOf, schemaAt, startService, type Deps } from "@apps/service-kit";
import { CatalogueStore, excerptOf } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";
import { textOf } from "./extract.ts";

function whoIs(req: Parameters<typeof personOf>[0]): Viewer | null {
  const person = personOf(req);
  return person ? { id: person.id, name: person.name, title: person.title } : null;
}

/** What the documents service starts the flow with; see its `ExtractJob`. */
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

/** What `extract` answers, and what the platform hands `index` under `results.extract`. */
interface Extracted {
  characters: number;
  excerpt: string;
  /** The text itself. A result is a JSON column on the platform; this fleet's documents are pages, not archives. */
  text: string;
}

type IndexJob = ExtractJob & { results: { extract: Extracted | null } };

const service = await startService({
  name: "catalogue",
  schema: schemaAt(new URL("./catalogue.rayfold", import.meta.url)),
  migrate: async (sql) => new CatalogueStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new CatalogueStore(deps.sql) }),
  viewer: (req) => whoIs(req),

  onStart: async (server, deps: Deps) => {
    const store = new CatalogueStore(deps.sql);
    const { platform } = deps;
    const { log } = platform;
    // NEEDS THE RAYFOLD CONSOLE: the queues below, and the flow that puts work on them, are the console's — a
    // separate commercial product in a private repository, not yet on sale. Without CONSOLE_URL these workers never
    // take a job and the Files kind stays empty; the rest of the catalogue serves as before.
    //
    // the queues' limits are this service's to state: it is the one that knows how long a file takes to read, and
    // how many it can read at once without starving the searches it serves
    await platform.defineQueue("extract-text", { maxAttempts: 5, leaseMs: 60_000, backoffMs: 5_000, concurrency: 4, timeoutMs: 120_000 });
    await platform.defineQueue("index-file", { maxAttempts: 3, leaseMs: 30_000, backoffMs: 2_000 });

    platform.work<ExtractJob>("extract-text", async ({ payload: job }): Promise<Extracted> => {
      const res = await fetch(job.fetchUrl);
      // gone is done: a document deleted before its job ran has nothing to index, and retrying will not bring it back.
      // no text means the index step is skipped by its own condition, and notify says so
      if (res.status === 404) {
        await store.removeFile(job.documentId);
        log.warn("a document was gone before its text could be read", { documentId: job.documentId, name: job.name });
        return { characters: 0, excerpt: "", text: "" };
      }
      if (!res.ok) throw new Error(`fetching the bytes answered ${res.status}`);
      const text = textOf(job.contentType, job.name, new Uint8Array(await res.arrayBuffer()));
      log.info("read a document's text", { documentId: job.documentId, name: job.name, version: job.version, characters: text.length });
      return { characters: text.length, excerpt: excerptOf(text), text };
    });

    platform.work<IndexJob>("index-file", async ({ payload: job }) => {
      const extracted = job.results.extract;
      if (!extracted) throw new Error("index-file ran without extract's result, which the flow is meant to prevent");
      const kept = await store.indexFile({
        id: job.documentId,
        name: job.name,
        projectId: job.projectId,
        contentType: job.contentType,
        size: job.size,
        url: job.url,
        text: extracted.text,
        version: job.version,
        updatedAt: Date.now(),
      });
      // a File is an entity this service returns from live queries: a screen that subscribes to `items` hears this
      if (kept) server.changes.publish({ keys: new Set([`File:${job.documentId}`]), ops: new Set(["items", "search"]) });
      log.info(kept ? "indexed a document's text" : "left a newer version's text in place", { documentId: job.documentId, name: job.name, version: job.version, characters: extracted.characters });
      return { indexed: kept, characters: extracted.characters };
    });
  },
});

export default service;
