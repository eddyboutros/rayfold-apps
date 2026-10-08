/** The documents and approvals services' rules over arrays, for the specs: what a command patches is what the service patches. */
import { RayfoldError, ok, type Resolvers } from "@rayfold/server/core";

export const T = "2026-03-04T12:00:00.000Z";
export const ADA = { id: "u1", name: "Ada Lovelace" };
export const GRACE = { id: "u2", name: "Grace Hopper" };
export const MEMBERS = [ADA, GRACE, { id: "u3", name: "Noor Haddad" }];

export interface DocRow {
  $type: "Document";
  id: string;
  name: string;
  projectId: string;
  ownerId: string;
  contentType: string;
  size: number;
  url: string;
  version: number;
  updatedAt: string;
  folder: string | null;
  tags: string[];
}

export interface NoteRow {
  id: string;
  documentId: string;
  body: string;
  at: string;
  byId: string;
}

export function docs(): DocRow[] {
  return [
    { $type: "Document", id: "d1", name: "brief.txt", projectId: "p1", ownerId: "u1", contentType: "text/plain", size: 120, url: "/files/r1", version: 1, updatedAt: T, folder: "contracts/2026", tags: ["legal"] },
    { $type: "Document", id: "d2", name: "budget.csv", projectId: "p1", ownerId: "u2", contentType: "text/csv", size: 3072, url: "/files/r2", version: 3, updatedAt: T, folder: null, tags: ["q4", "legal"] },
    { $type: "Document", id: "d9", name: "elsewhere.pdf", projectId: "p2", ownerId: "u1", contentType: "application/pdf", size: 9, url: "/files/r9", version: 1, updatedAt: T, folder: null, tags: [] },
  ];
}

/** The documents service's rules, over arrays: what a command patches is what the service patches. */
export function documentsResolvers(rows: DocRow[], notes: NoteRow[], hold?: { gate: Promise<void> }): Resolvers {
  let n = 0;
  const find = (id: string) => {
    const d = rows.find((r) => r.id === id);
    if (!d) throw RayfoldError.domain("NotFound", { id }, `No document ${id}`);
    return d;
  };
  const mine = (d: DocRow, viewer: { id: string }) => {
    if (d.ownerId !== viewer.id) throw RayfoldError.domain("Forbidden", { id: d.id }, `${d.name} is not yours`);
    return d;
  };
  const bump = (d: DocRow, change: Partial<DocRow>) => Object.assign(d, change, { version: d.version + 1 });
  return {
    Query: {
      me: (_: unknown, ctx) => MEMBERS.find((m) => m.id === (ctx.viewer as { id: string }).id) ?? null,
      shared: (_: unknown, ctx) => rows.find((r) => r.id === (ctx.viewer as { documentId?: string }).documentId) ?? null,
      documents: ({ projectId, folder, tag }: { projectId: string; folder?: string | null; tag?: string | null }) => {
        const items = rows.filter((r) => r.projectId === projectId && (!folder || r.folder === folder) && (!tag || r.tags.includes(tag)));
        return { items, total: items.length, hasMore: false, cursor: null };
      },
      folders: ({ projectId }: { projectId: string }) => {
        const names = [...new Set(rows.filter((r) => r.projectId === projectId && r.folder).map((r) => r.folder!))].sort();
        return names.map((name) => ({ name, count: rows.filter((r) => r.projectId === projectId && r.folder === name).length }));
      },
      notes: ({ documentId }: { documentId: string }) => {
        const items = notes.filter((x) => x.documentId === documentId);
        return { items, total: items.length, hasMore: false, cursor: null };
      },
      revisions: ({ documentId }: { documentId: string }) => {
        const d = find(documentId);
        const items = Array.from({ length: d.version }, (_, i) => ({
          id: `${d.id}-r${d.version - i}`,
          documentId,
          version: d.version - i,
          size: [100, 2048, 3 * 1024 * 1024][i] ?? 1,
          url: i === 2 ? "https://cdn.example/old" : `/files/${d.id}-r${d.version - i}`,
          at: T,
          byId: i === 1 ? "u1" : d.ownerId,
        }));
        return { items, total: items.length, hasMore: false, cursor: null };
      },
    },
    Command: {
      createDocument: async ({ upload, name, projectId }: { upload: string; name: string; projectId: string }, ctx) => {
        if (hold) await hold.gate;
        const doc: DocRow = { $type: "Document", id: `new${++n}`, name, projectId, ownerId: (ctx.viewer as { id: string }).id, contentType: "text/plain", size: 3, url: `/files/${upload}`, version: 1, updatedAt: T, folder: null, tags: [] };
        rows.unshift(doc);
        return ok(doc);
      },
      replaceContent: ({ id, upload }: { id: string; upload: string }, ctx) => {
        const d = mine(find(id), ctx.viewer as { id: string });
        ctx.checkVersion(`Document:${d.id}`, d.version, d);
        return ok(bump(d, { url: `/files/${upload}` }));
      },
      updateDocument: ({ id, changes }: { id: string; changes: { name?: string } }, ctx) => {
        const d = mine(find(id), ctx.viewer as { id: string });
        ctx.checkVersion(`Document:${d.id}`, d.version, d);
        return ok(bump(d, changes.name ? { name: changes.name } : {}), { patch: [{ invOp: ["documents", "folders"] }] });
      },
      moveDocument: ({ id, folder }: { id: string; folder?: string | null }, ctx) => {
        const d = mine(find(id), ctx.viewer as { id: string });
        ctx.checkVersion(`Document:${d.id}`, d.version, d);
        return ok(bump(d, { folder: folder ?? null }), { patch: [{ invOp: ["documents", "folders"] }] });
      },
      tagDocument: ({ id, tags }: { id: string; tags: string[] }, ctx) => {
        const d = find(id);
        ctx.checkVersion(`Document:${d.id}`, d.version, d);
        return ok(bump(d, { tags }), { patch: [{ invOp: ["documents"] }] });
      },
      addNote: ({ documentId, body }: { documentId: string; body: string }, ctx) => {
        if (body === "fail") throw RayfoldError.domain("NotFound", { id: documentId }, "That file is gone");
        const note = { id: `n${notes.length + 1}`, documentId, body, at: T, byId: (ctx.viewer as { id: string }).id };
        notes.push(note);
        return ok(note);
      },
      shareDocument: ({ id }: { id: string }, ctx) => {
        const d = mine(find(id), ctx.viewer as { id: string });
        return ok({ id: "s1", documentId: d.id, token: "rfcap1.tok/en", expiresAt: T, ops: ["shared"] });
      },
      deleteDocument: ({ id }: { id: string }, ctx) => {
        const d = mine(find(id), ctx.viewer as { id: string });
        rows.splice(rows.indexOf(d), 1);
        return ok(d);
      },
    },
    Document: { owner: (ds: DocRow[]) => ds.map((d) => MEMBERS.find((m) => m.id === d.ownerId) ?? null) },
    // one note-writer whose name is written in lower case, as an identity provider may hand it over
    Note: { by: (ns: NoteRow[]) => ns.map((x) => [...MEMBERS, { id: "u9", name: "lin wei" }].find((m) => m.id === x.byId) ?? null) },
    Revision: { by: (rs: Array<{ byId: string }>) => rs.map((r) => MEMBERS.find((m) => m.id === r.byId) ?? null) },
  } as Resolvers;
}

export interface ApprovalRow {
  id: string;
  documentId: string;
  projectId: string;
  documentName: string;
  version: number;
  requesterId: string;
  approverId: string;
  decision: "pending" | "approved" | "declined" | "withdrawn";
  note: string | null;
  stale: boolean;
  askedAt: string;
  decidedAt: string | null;
}

export function approvalsResolvers(rows: ApprovalRow[], stuck?: Promise<never>): Resolvers {
  const find = (id: string) => rows.find((r) => r.id === id)!;
  return {
    Query: {
      approvals: ({ documentId }: { documentId: string }) => stuck ?? rows.filter((r) => r.documentId === documentId),
      members: () => MEMBERS,
      approval: ({ id }: { id: string }) => find(id) ?? null,
      inbox: () => [],
    },
    Command: {
      requestApproval: (args: Omit<ApprovalRow, "id" | "requesterId" | "decision" | "note" | "stale" | "askedAt" | "decidedAt">, ctx) => {
        const requesterId = (ctx.viewer as { id: string }).id;
        if (args.approverId === requesterId) throw RayfoldError.domain("NotYours", { id: args.documentId }, "You cannot ask yourself");
        const row: ApprovalRow = { ...args, id: `a${rows.length + 1}`, requesterId, decision: "pending", note: null, stale: false, askedAt: T, decidedAt: null };
        rows.unshift(row);
        return ok(row, { patch: [{ invOp: ["approvals"] }] });
      },
      decide: ({ id, decision, note }: { id: string; decision: "approved" | "declined"; note: string | null }) => ok(Object.assign(find(id), { decision, note, decidedAt: T })),
      withdraw: ({ id }: { id: string }) => ok(Object.assign(find(id), { decision: "withdrawn", decidedAt: T })),
    },
    Approval: {
      requester: (as: ApprovalRow[]) => as.map((a) => MEMBERS.find((m) => m.id === a.requesterId) ?? null),
      approver: (as: ApprovalRow[]) => as.map((a) => MEMBERS.find((m) => m.id === a.approverId) ?? null),
    },
  } as Resolvers;
}

