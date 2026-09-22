/**
 * What the documents service does.
 *
 * Two rules run through all of it. The bytes are never in a row and never in an answer — a command moves them into
 * the file store and keeps the URL. And who may read a document is one expression in the schema, not a check
 * repeated in each resolver: its owner, or the holder of a share minted for it.
 */
import { RayfoldError, ok, type Resolvers, type UploadStore } from "@rayfold/server";
import type { Capabilities } from "@rayfold/server";
import type { Log, Platform } from "@apps/service-kit";
import type { FileStore } from "./files.ts";
import type { Document, Member, Revision } from "./store.ts";
import type { DocumentStore } from "./store.ts";

export interface Viewer {
  id: string;
  name?: string;
  /** Set only on the viewer a share's token speaks for: the one document it may read. */
  documentId?: string;
}

export interface Share {
  id: string;
  documentId: string;
  token: string;
  expiresAt: number;
  ops: string[];
}

/** What a share's holder may call. Reading only: a share is a link, not an account. */
export const SHARED_OPS = ["document", "revisions"];

export interface Parts {
  store: DocumentStore;
  files: FileStore;
  uploads: UploadStore;
  caps: Capabilities;
  /** The queue a kept document's text extraction goes on. */
  platform: Platform;
  log: Log;
  /** Where a worker reaches this service, for the URL the job carries. */
  selfUrl: string;
  /** The most bytes a document may be, read each time: the platform can change it while the service runs. */
  limitBytes: () => number;
  id?: () => string;
  now?: () => number;
}

export const DOCUMENT_KEPT = "document-kept";

/**
 * What happens to a document once it is kept, as the platform runs it: three steps on three queues, each on the
 * service that owns the work.
 *
 * `extract` reads the bytes; `index` runs only when there was text to index — a condition on the step before it,
 * not an `if` in a worker — and `notify` tells the workspace either way. The lock keeps two versions of one document
 * from being worked on at the same time, whichever queue the step is on: the race that would otherwise index an
 * older version last.
 */
export const DOCUMENT_KEPT_STEPS = [
  { name: "extract", queue: "extract-text", lock: "doc:{documentId}", retries: 5, timeoutMs: 60_000 },
  { name: "index", queue: "index-file", after: ["extract"], when: { step: "extract", path: "characters", notEquals: 0 }, lock: "doc:{documentId}" },
  { name: "notify", queue: "notify-workspace", after: ["index"] },
];

/** What the extract step is handed: enough to fetch the bytes and to say what they belong to. */
export interface ExtractJob {
  documentId: string;
  projectId: string;
  name: string;
  version: number;
  contentType: string;
  size: number;
  /** The document's own path, as the catalogue links to it. */
  url: string;
  /** Where the bytes are fetched from, with a capability token that reads this document and nothing else. */
  fetchUrl: string;
}

export function resolvers({ store, files, uploads, caps, platform, log, selfUrl, limitBytes, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  const find = async (documentId: string): Promise<Document> => {
    const doc = await store.document(documentId);
    if (!doc) throw RayfoldError.domain("NotFound", { id: documentId }, `No document ${documentId}`);
    return doc;
  };

  const mine = (doc: Document, viewer: Viewer): Document => {
    if (doc.ownerId !== viewer.id) throw RayfoldError.domain("Forbidden", { id: doc.id }, `${doc.name} is not yours`);
    return doc;
  };

  /**
   * Moves an upload's bytes into the file store under a fresh revision id. The upload is gone afterwards. Bytes over
   * the platform's limit are taken back rather than kept: the limit is checked on what actually arrived, because the
   * upload route cannot know what a client will claim.
   */
  const keep = async (upload: string): Promise<{ revisionId: string; size: number; type?: string | undefined }> => {
    const kept = await uploads.open(upload);
    if (!kept) throw RayfoldError.domain("UploadGone", { upload }, `Upload ${upload} is not there any more`);
    const revisionId = id();
    const size = await files.write(revisionId, kept.body);
    await uploads.delete(upload);
    const limit = limitBytes();
    if (size > limit) {
      await files.remove(revisionId);
      log.warn("refused an upload over the limit", { size, limit });
      throw RayfoldError.domain("UploadTooLarge", { size, limit }, `${size} bytes is over the limit of ${limit}`);
    }
    return { revisionId, size, type: kept.upload.type };
  };

  /**
   * Hands the document to the fleet, through the platform: a run of the `document-kept` flow — extract its text,
   * index it if there was any, tell the workspace — with a capability token that reads this document and nothing
   * else, for the hour a token may live at most: the workers never hold a person's session, and a run that has
   * waited longer than that is started again by hand rather than given a token that would outlive the reason it was
   * minted. A platform that is down does not fail the upload; the document is kept and the run is the platform's to
   * start when it is back.
   */
  const extractLater = async (doc: Document): Promise<void> => {
    const token = caps.mint({ id: `job:${doc.id}`, documentId: doc.id }, { ops: ["document"], ttlMs: 60 * 60 * 1000, iss: "documents" });
    const job: ExtractJob = {
      documentId: doc.id,
      projectId: doc.projectId,
      name: doc.name,
      version: doc.version,
      contentType: doc.contentType,
      size: doc.size,
      url: doc.url,
      fetchUrl: `${selfUrl}${doc.url}?token=${encodeURIComponent(token)}`,
    };
    try {
      // one run per revision: a retry of the command replays, and a second instance's start finds this one
      const run = await platform.startFlow(DOCUMENT_KEPT, job, { key: `${doc.id}:${doc.version}` });
      if (run) log.info("started the document-kept flow", { documentId: doc.id, version: doc.version, run: run.id });
    } catch (e) {
      log.error("could not start the document-kept flow", { documentId: doc.id, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const pageOf = <T>(items: T[], total: number, cursor: (t: T) => string) => ({
    items,
    total,
    hasMore: items.length > 0 && total > items.length,
    cursor: items.length ? cursor(items[items.length - 1]!) : null,
  });

  return {
    Query: {
      me: (_: unknown, ctx) => store.member((ctx.viewer as Viewer).id),

      document: ({ id: documentId }: { id: string }) => store.document(documentId),

      documents: async ({ projectId, page }: { projectId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.documentsOf(projectId, page.first, page.after ?? null);
        return pageOf(items, total, (d) => d.id);
      },

      revisions: async ({ documentId, page }: { documentId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.revisionsOf(documentId, page.first, page.after ?? null);
        return pageOf(items, total, (r) => r.id);
      },
    },

    Command: {
      createDocument: async ({ upload, name, projectId }: { upload: string; name: string; projectId: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const { revisionId, size, type } = await keep(upload);
        const at = now();
        const doc: Document = {
          id: id(),
          name,
          projectId,
          contentType: type ?? "application/octet-stream",
          size,
          url: files.url(revisionId),
          version: 1,
          updatedAt: at,
          ownerId: viewer.id,
        };
        await store.create(doc, { id: revisionId, documentId: doc.id, version: 1, size, url: doc.url, at, byId: viewer.id });
        log.info("kept a document", { documentId: doc.id, name: doc.name, size, projectId, by: viewer.id });
        await extractLater(doc);
        return ok(doc, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, projectId: doc.projectId, name: doc.name, version: 1, byId: viewer.id } }] });
      },

      replaceContent: async ({ id: documentId, upload }: { id: string; upload: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = mine(await find(documentId), viewer);
        // before the bytes move: a replace that would land on top of someone else's is refused here, so a losing
        // write never leaves a file behind
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const { revisionId, size, type } = await keep(upload);
        const at = now();
        const next: Document = { ...doc, contentType: type ?? doc.contentType, size, url: files.url(revisionId), version: doc.version + 1, updatedAt: at };
        const won = await store.replace(next, { id: revisionId, documentId: doc.id, version: next.version, size, url: next.url, at, byId: viewer.id }, doc.version);
        if (!won) {
          // another replace landed between the read above and this write. its bytes are already on disk, so they
          // are taken back rather than left as a file nothing refers to.
          await files.remove(revisionId);
          const current = await find(documentId);
          ctx.checkVersion(`Document:${doc.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: documentId }, `Document ${documentId} changed while this was running`);
        }
        log.info("replaced a document's bytes", { documentId: doc.id, version: next.version, size, by: viewer.id });
        await extractLater(next);
        return ok(next, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, projectId: doc.projectId, name: doc.name, version: next.version, byId: viewer.id } }] });
      },

      renameDocument: async ({ id: documentId, name }: { id: string; name: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = mine(await find(documentId), viewer);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const next = { ...doc, name, version: doc.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);
        await store.rename(doc.id, name, next.version, next.updatedAt);
        return ok(next, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, projectId: doc.projectId, name: next.name, version: next.version, byId: viewer.id } }] });
      },

      shareDocument: async ({ id: documentId, ttlMs }: { id: string; ttlMs: number }, ctx) => {
        const doc = mine(await find(documentId), ctx.viewer as Viewer);
        // the viewer the token speaks for is not an account: it exists only to satisfy the policy on Document,
        // which reads viewer.documentId. so a share cannot be turned into a way to read anything else.
        const token = caps.mint({ id: `share:${doc.id}`, documentId: doc.id }, { ops: SHARED_OPS, ttlMs, iss: "documents" });
        return ok({ id: id(), documentId: doc.id, token, expiresAt: now() + ttlMs, ops: SHARED_OPS });
      },

      deleteDocument: async ({ id: documentId }: { id: string }, ctx) => {
        const doc = mine(await find(documentId), ctx.viewer as Viewer);
        const revisions = await store.remove(doc.id);
        // the row is gone first: bytes with no row are swept, a row with no bytes is a broken document
        for (const revisionId of revisions) await files.remove(revisionId);
        log.info("deleted a document", { documentId: doc.id, name: doc.name, revisions: revisions.length, by: (ctx.viewer as Viewer).id });
        return ok(doc);
      },
    },

    Document: {
      owner: async (docs: Document[]) => {
        const members = await store.membersByIds([...new Set(docs.map((d) => d.ownerId))]);
        return docs.map((d) => members.get(d.ownerId) ?? null);
      },
    },

    Revision: {
      by: async (revisions: Revision[]) => {
        const members = await store.membersByIds([...new Set(revisions.map((r) => r.byId))]);
        return revisions.map((r) => members.get(r.byId) ?? null);
      },
    },
  } satisfies Resolvers as Resolvers;
}

export type { Document, Member, Revision };
