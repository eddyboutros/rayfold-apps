/**
 * What the documents service does.
 *
 * Two rules run through all of it. The bytes are never in a row and never in an answer — a command moves them into
 * the file store and keeps the URL. And who may read a document is one expression in the schema, not a check
 * repeated in each resolver: its owner, or the holder of a share minted for it.
 */
import { RayfoldError, ok, type Resolvers, type UploadStore } from "@rayfold/server";
import type { Capabilities } from "@rayfold/server";
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
  id?: () => string;
  now?: () => number;
}

export function resolvers({ store, files, uploads, caps, id = () => crypto.randomUUID(), now = Date.now }: Parts): Resolvers {
  const find = async (documentId: string): Promise<Document> => {
    const doc = await store.document(documentId);
    if (!doc) throw RayfoldError.domain("NotFound", { id: documentId }, `No document ${documentId}`);
    return doc;
  };

  const mine = (doc: Document, viewer: Viewer): Document => {
    if (doc.ownerId !== viewer.id) throw RayfoldError.domain("Forbidden", { id: doc.id }, `${doc.name} is not yours`);
    return doc;
  };

  /** Moves an upload's bytes into the file store under a fresh revision id. The upload is gone afterwards. */
  const keep = async (upload: string): Promise<{ revisionId: string; size: number; type?: string | undefined }> => {
    const kept = await uploads.open(upload);
    if (!kept) throw RayfoldError.domain("UploadGone", { upload }, `Upload ${upload} is not there any more`);
    const revisionId = id();
    const size = await files.write(revisionId, kept.body);
    await uploads.delete(upload);
    return { revisionId, size, type: kept.upload.type };
  };

  const pageOf = <T>(items: T[], total: number, cursor: (t: T) => string) => ({
    items,
    total,
    hasMore: items.length > 0 && total > items.length,
    cursor: items.length ? cursor(items[items.length - 1]!) : null,
  });

  return {
    Query: {
      document: ({ id: documentId }: { id: string }) => store.document(documentId),

      documents: async ({ page }: { page: { first: number; after?: string | null } }, ctx) => {
        const { items, total } = await store.documentsOf((ctx.viewer as Viewer).id, page.first, page.after ?? null);
        return pageOf(items, total, (d) => d.id);
      },

      revisions: async ({ documentId, page }: { documentId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.revisionsOf(documentId, page.first, page.after ?? null);
        return pageOf(items, total, (r) => r.id);
      },
    },

    Command: {
      createDocument: async ({ upload, name }: { upload: string; name: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const { revisionId, size, type } = await keep(upload);
        const at = now();
        const doc: Document = {
          id: id(),
          name,
          contentType: type ?? "application/octet-stream",
          size,
          url: files.url(revisionId),
          version: 1,
          updatedAt: at,
          ownerId: viewer.id,
        };
        await store.create(doc, { id: revisionId, documentId: doc.id, version: 1, size, url: doc.url, at, byId: viewer.id });
        return ok(doc, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, name: doc.name, version: 1 } }] });
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
        return ok(next, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, name: doc.name, version: next.version } }] });
      },

      renameDocument: async ({ id: documentId, name }: { id: string; name: string }, ctx) => {
        const doc = mine(await find(documentId), ctx.viewer as Viewer);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const next = { ...doc, name, version: doc.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);
        await store.rename(doc.id, name, next.version, next.updatedAt);
        return ok(next, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, name: next.name, version: next.version } }] });
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
