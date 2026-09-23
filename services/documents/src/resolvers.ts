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
import type { Document, Member, Note, Revision } from "./store.ts";
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
export const SHARED_OPS = ["document", "shared", "revisions"];

/** Tags as the team sees them: trimmed, lower-cased, no blanks, each once. */
const tidy = (tags: string[]): string[] => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

/** A folder path as it is kept: no leading or trailing slashes, no empty segments, null when there is nothing left. */
const folderOf = (folder: string | null | undefined): string | null => {
  const clean = (folder ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
  return clean || null;
};

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
 * NEEDS THE RAYFOLD CONSOLE. The flow, its queues and the workers' claims are the console's — a separate commercial
 * product, in a private repository, not yet on sale. Without `CONSOLE_URL` the run below is not started, the
 * document is still kept and served, and it simply never becomes searchable in the catalogue.
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
  /** Who kept it, so the last step can tell them. */
  byId: string;
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
  const extractLater = async (doc: Document, byId: string): Promise<void> => {
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
      byId,
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

      // the token says which one: the policy already refused anyone whose viewer names no document
      shared: (_: unknown, ctx) => store.document((ctx.viewer as Viewer).documentId ?? ""),

      documents: async ({ projectId, folder, tag, page }: { projectId: string; folder?: string | null; tag?: string | null; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.documentsOf(projectId, { folder: folderOf(folder), tag: tag?.trim().toLowerCase() || null }, page.first, page.after ?? null);
        return pageOf(items, total, (d) => d.id);
      },

      folders: ({ projectId }: { projectId: string }) => store.folders(projectId),

      notes: async ({ documentId, page }: { documentId: string; page: { first: number; after?: string | null } }) => {
        const { items, total } = await store.notes(documentId, page.first, page.after ?? null);
        return pageOf(items, total, (n) => n.id);
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
          folder: null,
          tags: [],
        };
        await store.create(doc, { id: revisionId, documentId: doc.id, version: 1, size, url: doc.url, at, byId: viewer.id });
        log.info("kept a document", { documentId: doc.id, name: doc.name, size, projectId, by: viewer.id });
        await extractLater(doc, viewer.id);
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
        await extractLater(next, viewer.id);
        return ok(next, { emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, projectId: doc.projectId, name: doc.name, version: next.version, byId: viewer.id } }] });
      },

      updateDocument: async ({ id: documentId, changes }: { id: string; changes: { name?: string | null; folder?: string | null; tags?: string[] | null } }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = mine(await find(documentId), viewer);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        // only what was sent (spec 03 section 2): a name cannot be cleared, a folder can
        if (changes.name === null || changes.tags === null) throw new RayfoldError("invalid_argument", "updateDocument().changes: name and tags cannot be null");
        const next: Document = {
          ...doc,
          ...("name" in changes && changes.name !== undefined ? { name: changes.name } : {}),
          ...("folder" in changes && changes.folder !== undefined ? { folder: folderOf(changes.folder) } : {}),
          ...("tags" in changes && changes.tags !== undefined ? { tags: tidy(changes.tags) } : {}),
          version: doc.version + 1,
          updatedAt: now(),
        };
        if (ctx.simulate) return ok(next);
        if (!(await store.update(next, doc.version))) {
          const current = await find(documentId);
          ctx.checkVersion(`Document:${doc.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: documentId }, `Document ${documentId} changed while this was running`);
        }
        return ok(next, { patch: [{ invOp: ["documents", "folders"] }], emit: [{ event: "DocumentChanged", payload: { documentId: doc.id, projectId: doc.projectId, name: next.name, version: next.version, byId: viewer.id } }] });
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

      moveDocument: async ({ id: documentId, folder }: { id: string; folder?: string | null }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = mine(await find(documentId), viewer);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const next: Document = { ...doc, folder: folderOf(folder), version: doc.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);
        if (!(await store.file(doc.id, next.folder, doc.version, next.updatedAt))) {
          const current = await find(documentId);
          ctx.checkVersion(`Document:${doc.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: documentId }, `Document ${documentId} changed while this was running`);
        }
        // every open list of the project re-runs: a document filed elsewhere leaves one folder's list and joins another's
        return ok(next, { patch: [{ invOp: ["documents", "folders"] }], emit: [{ event: "DocumentFiled", payload: { documentId: doc.id, projectId: doc.projectId, name: doc.name, folder: next.folder, byId: viewer.id, at: now() } }] });
      },

      tagDocument: async ({ id: documentId, tags }: { id: string; tags: string[] }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = await find(documentId);
        ctx.checkVersion(`Document:${doc.id}`, doc.version, doc);
        const next: Document = { ...doc, tags: tidy(tags), version: doc.version + 1, updatedAt: now() };
        if (ctx.simulate) return ok(next);
        if (!(await store.tag(doc.id, next.tags, doc.version, next.updatedAt))) {
          const current = await find(documentId);
          ctx.checkVersion(`Document:${doc.id}`, current.version, current);
          throw RayfoldError.domain("NotFound", { id: documentId }, `Document ${documentId} changed while this was running`);
        }
        return ok(next, { patch: [{ invOp: ["documents"] }], emit: [{ event: "DocumentTagged", payload: { documentId: doc.id, projectId: doc.projectId, name: doc.name, tags: next.tags, byId: viewer.id, at: now() } }] });
      },

      addNote: async ({ documentId, body }: { documentId: string; body: string }, ctx) => {
        const viewer = ctx.viewer as Viewer;
        const doc = await find(documentId);
        const note: Note = { id: id(), documentId, body, at: now(), byId: viewer.id };
        await store.addNote(note);
        // a new Note: every open list of this document's notes re-runs by the type rule, so no patch is needed
        return ok(note, { emit: [{ event: "DocumentNoted", payload: { documentId, projectId: doc.projectId, name: doc.name, excerpt: body.slice(0, 80), byId: viewer.id } }] });
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

    Note: {
      by: async (notes: Note[]) => {
        const members = await store.membersByIds([...new Set(notes.map((n) => n.byId))]);
        return notes.map((n) => members.get(n.byId) ?? null);
      },
    },
  } satisfies Resolvers as Resolvers;
}

export type { Document, Member, Note, Revision };
