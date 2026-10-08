import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { Capabilities } from "@rayfold/server";
import pg from "pg";
import { DATABASE_URL, liveClosed, startTestService, type TestService } from "../../../e2e/harness.ts";
import { startStandInConsole, type StandInConsole } from "../../../e2e/stand-in-console.ts";
import { signal, until } from "../../../e2e/wait.ts";
import { FileStore } from "./files.ts";
import { DOCUMENT_KEPT, DOCUMENT_KEPT_STEPS, SHARED_OPS } from "./resolvers.ts";
import { DocumentStore } from "./store.ts";

/**
 * The documents service as it runs: a real Postgres, a real port, the real client. What is asserted is what the
 * service promises — the bytes are a file, the row carries only their URL, a share reads one document, and a
 * losing replace leaves nothing behind.
 */
let svc: TestService;
let dirs: { files: string; uploads: string };
/** The platform, as far as this service can tell: its configuration and its queue. */
let platform: StandInConsole;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "documents-"));
  dirs = { files: join(root, "files"), uploads: join(root, "uploads") };
  platform = await startStandInConsole();
  svc = await startTestService("documents", { FILES_DIR: dirs.files, UPLOADS_DIR: dirs.uploads, CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token, APP_ENVIRONMENT: "test" });
});

afterAll(async () => {
  await svc?.stop();
  await platform?.stop();
  await rm(dirs.files, { recursive: true, force: true });
  await rm(dirs.uploads, { recursive: true, force: true });
});

const operator = () => new RayfoldClient({ transport: createFetchTransport({ url: `${platform.url}/rayfold`, headers: () => ({ authorization: `Bearer ${platform.token}` }) }) });
const configure = (key: string, value: string) =>
  operator().command("setConfig", { app: "documents", environment: "test", key, value }, { shape: "{ key }", key: crypto.randomUUID() });

beforeEach(async () => {
  await svc.reset();
  // the rows and the bytes are two stores, and truncating one leaves the other: a test that counts files has to
  // clear both, exactly as deleting a document has to
  await rm(dirs.files, { recursive: true, force: true });
  await rm(dirs.uploads, { recursive: true, force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await liveClosed(svc);
});

const client = (who: string) => svc.client(who);

async function upload(who: string, bytes: Uint8Array, type = "text/plain"): Promise<string> {
  const res = await fetch(`${svc.base}/rayfold/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${who}`, "rayfold-upload-type": type },
    body: bytes as BodyInit,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const download = (url: string, who?: string) => fetch(`${svc.base}${url}`, who ? { headers: { authorization: `Bearer ${who}` } } : undefined);
const text = (s: string) => new TextEncoder().encode(s);
const SHAPE = "{ id name contentType size url version owner { name } }";

interface Document {
  id: string;
  name: string;
  size: number;
  url: string;
  version: number;
}
interface Share {
  token: string;
  ops: string[];
}

it("keeps an uploaded file, answers with its url, and serves the bytes from there", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("the first draft")), name: "draft.txt" }, { shape: SHAPE });

  expect(doc).toMatchObject({ name: "draft.txt", size: 15, version: 1, owner: { name: "Ada Lovelace" } });
  expect(JSON.stringify(doc)).not.toContain("the first draft");
  expect(await (await download(doc.url, "ada")).text()).toBe("the first draft");

  // the row carries the url and the bytes are one file on the volume, not a column
  const { rows } = await svc.sql.query("select url, size from documents where id = $1", [doc.id]);
  expect(rows[0]).toMatchObject({ url: doc.url, size: "15" });
  expect(await readdir(dirs.files)).toHaveLength(1);
});

it("replaces the bytes, keeps the old revision, and both urls still serve", async () => {
  const ada = client("ada");
  const first = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("one")), name: "draft.txt" }, { shape: SHAPE });
  const second = await ada.command<Document>("replaceContent", { id: first.id, upload: await upload("ada", text("two and a half")) }, { shape: SHAPE });

  expect(second).toMatchObject({ id: first.id, version: 2, size: 14 });
  expect(await (await download(second.url, "ada")).text()).toBe("two and a half");
  expect(await (await download(first.url, "ada")).text()).toBe("one");

  const history = await ada.query<{ items: Array<{ version: number; by: { name: string } }> }>(
    "revisions",
    { documentId: first.id },
    { shape: "{ items { version by { name } } }" },
  );
  expect(history.items.map((r) => r.version)).toEqual([2, 1]);
});

it("refuses a replace that would land on top of someone else's, and leaves no file behind", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("one")), name: "draft.txt" }, { shape: SHAPE });
  await ada.command<Document>("replaceContent", { id: doc.id, upload: await upload("ada", text("two")) }, { shape: SHAPE });

  const stale = await upload("ada", text("three"));
  const conflict = await ada
    .command<Document>("replaceContent", { id: doc.id, upload: stale }, { shape: SHAPE, ifVersion: 1 })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(conflict).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  expect(conflict?.data).toMatchObject({ expected: 1, actual: 2 });

  // checked before the bytes move: two revisions on disk, not three
  expect(await readdir(dirs.files)).toHaveLength(2);

  // guard: the same write with the version it actually has goes through
  const won = await ada.command<Document>("replaceContent", { id: doc.id, upload: stale }, { shape: SHAPE, ifVersion: 2 });
  expect(won.version).toBe(3);
});

it("a share reads that one document and its bytes, and nothing else", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("for the lawyer")), name: "contract.txt" }, { shape: SHAPE });
  const other = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("not for them")), name: "salaries.txt" }, { shape: SHAPE });

  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ documentId token ops }" });
  expect(share.ops).toEqual(["document", "shared", "revisions"]);

  const guest = client(share.token);
  expect(await guest.query<Document>("document", { id: doc.id }, { shape: "{ name }" })).toMatchObject({ name: "contract.txt" });
  expect(await (await download(doc.url, share.token)).text()).toBe("for the lawyer");

  // a refused entity at a nullable position is not there, so a share cannot be used to learn what else exists
  expect(await guest.query<Document | null>("document", { id: other.id }, { shape: "{ name }" })).toBeNull();
  expect((await download(other.url, share.token)).status).toBe(404);
});

it("a share's token says which document it is for, and the team's own session says none", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("for the lawyer")), name: "contract.txt" }, { shape: SHAPE });
  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  // the landing page asks this, with nothing but the token: no id travels in the link
  expect(await client(share.token).query<Document>("shared", {}, { shape: "{ id name size }" })).toMatchObject({ id: doc.id, name: "contract.txt", size: 14 });
  // a signed-in person has no share: the policy refuses rather than answering null, so a page cannot mistake one for the other
  const mine = await ada.query("shared", {}, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(mine?.code).toBe("permission_denied");
});

it("a document is filed in a folder and tagged; the list narrows by either; the folders count what they hold", async () => {
  const ada = client("ada");
  const grace = client("grace");
  const F = "{ id version folder tags }";
  const msa = await ada.command<Document & { folder: string | null; tags: string[] }>("createDocument", { projectId: "p1", upload: await upload("ada", text("msa")), name: "msa.pdf" }, { shape: F });
  const dpa = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("dpa")), name: "dpa.pdf" }, { shape: F });
  const plan = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("plan")), name: "plan.md" }, { shape: F });
  expect(msa).toMatchObject({ folder: null, tags: [] });

  // the path is tidied, the version moves, and only the owner files
  const filed = await ada.command<Document & { folder: string | null }>("moveDocument", { id: msa.id, folder: " /contracts/2026/ " }, { shape: F, ifVersion: msa.version });
  expect(filed).toMatchObject({ folder: "contracts/2026", version: 2 });
  await ada.command("moveDocument", { id: dpa.id, folder: "contracts/2026" }, { shape: F, ifVersion: dpa.version });
  const notOwner = await grace.command("moveDocument", { id: plan.id, folder: "plans" }, { shape: F, ifVersion: plan.version }).then(() => null, (e: RayfoldClientError) => e);
  expect(notOwner).toMatchObject({ code: "domain", type: "Forbidden" });
  // but anyone on the team tags, and the tags are tidied too
  const tagged = await grace.command<Document & { tags: string[] }>("tagDocument", { id: plan.id, tags: ["Legal", " legal", "Q4"] }, { shape: F, ifVersion: plan.version });
  expect(tagged).toMatchObject({ tags: ["legal", "q4"], version: 2 });
  await ada.command("tagDocument", { id: msa.id, tags: ["legal"] }, { shape: F, ifVersion: 2 });

  const names = async (args: Record<string, unknown>) => (await ada.query<{ items: Array<{ name: string }> }>("documents", { projectId: "p1", ...args }, { shape: "{ items { name } }" })).items.map((d) => d.name).sort();
  expect(await names({})).toEqual(["dpa.pdf", "msa.pdf", "plan.md"]);
  expect(await names({ folder: "contracts/2026" })).toEqual(["dpa.pdf", "msa.pdf"]);
  expect(await names({ tag: "Legal" })).toEqual(["msa.pdf", "plan.md"]);
  expect(await names({ folder: "contracts/2026", tag: "legal" })).toEqual(["msa.pdf"]);
  // guard: a folder nobody used narrows to nothing rather than to everything
  expect(await names({ folder: "nope" })).toEqual([]);
  expect(await ada.query("folders", { projectId: "p1" }, { shape: "{ name count }" })).toEqual([{ name: "contracts/2026", count: 2 }]);

  // back to the root with null, and the folder is gone with its last document
  await ada.command("moveDocument", { id: msa.id, folder: null }, { shape: F, ifVersion: 3 });
  await ada.command("moveDocument", { id: dpa.id, folder: "" }, { shape: F, ifVersion: 2 });
  expect(await ada.query("folders", { projectId: "p1" }, { shape: "{ name count }" })).toEqual([]);
});

it("a note on a document is the team's to read and write, and a share sees none of them", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("draft")), name: "draft.txt" }, { shape: SHAPE });
  await ada.command("addNote", { documentId: doc.id, body: "Section 3 needs the export clause." }, { shape: "{ id }" });
  await client("grace").command("addNote", { documentId: doc.id, body: "Added it, see v2." }, { shape: "{ id }" });
  const notes = await client("noor").query<{ items: Array<{ body: string; by: { name: string } }>; total: number }>("notes", { documentId: doc.id }, { shape: "{ items { body by { name } } total }" });
  expect(notes.total).toBe(2);
  expect(notes.items.map((n) => [n.by.name, n.body])).toEqual([
    ["Ada Lovelace", "Section 3 needs the export clause."],
    ["Grace Hopper", "Added it, see v2."],
  ]);

  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const guest = client(share.token);
  const read = await guest.query("notes", { documentId: doc.id }, { shape: "{ total }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(read?.code).toBe("permission_denied");
  const wrote = await guest.command("addNote", { documentId: doc.id, body: "hello" }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(wrote?.code).toBe("permission_denied");
  // guard: the same token still reads the document itself
  expect(await guest.query<Document>("document", { id: doc.id }, { shape: "{ name }" })).toMatchObject({ name: "draft.txt" });
});

it("a share cannot change anything, and cannot be widened", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("read only")), name: "contract.txt" }, { shape: SHAPE });
  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const guest = client(share.token);

  for (const [op, args] of [
    ["renameDocument", { id: doc.id, name: "mine now" }],
    ["deleteDocument", { id: doc.id }],
  ] as const) {
    const refused = await guest.command(op, args, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
    expect(refused?.code, op).toBe("permission_denied");
  }
  expect(await ada.query<Document>("document", { id: doc.id }, { shape: "{ name version }" })).toMatchObject({ name: "contract.txt", version: 1 });
});

it("the url is not a permission", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("private")), name: "draft.txt" }, { shape: SHAPE });

  expect((await download(doc.url)).status).toBe(401);
  expect((await download(doc.url, "mallory")).status).toBe(401); // not on the team is nobody
  // a share for a different document names the bytes and still may not have them
  const other = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("the other")), name: "other.txt" }, { shape: SHAPE });
  const share = await client("ada").command<Share>("shareDocument", { id: other.id }, { shape: "{ token }" });
  expect((await download(doc.url, share.token)).status).toBe(404);
  expect(await (await download(doc.url, "ada")).text()).toBe("private"); // guard: its owner still reads it
});

it("a project's files are the team's to read, and the owner's to change", async () => {
  const ada = client("ada");
  const grace = client("grace");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("the plan")), name: "plan.txt" }, { shape: SHAPE });

  // Grace did not upload it and sees it, in the list and on the wire
  const listed = await grace.query<{ items: Array<{ name: string; owner: { name: string } }> }>("documents", { projectId: "p1" }, { shape: "{ items { name owner { name } } }" });
  expect(listed.items).toEqual([{ $type: "Document", name: "plan.txt", owner: { $type: "Member", name: "Ada Lovelace" } }]);
  expect(await (await download(doc.url, "grace")).text()).toBe("the plan");

  // and may not change it: that is its owner's
  for (const [op, args] of [
    ["renameDocument", { id: doc.id, name: "grace's now" }],
    ["shareDocument", { id: doc.id }],
    ["deleteDocument", { id: doc.id }],
  ] as const) {
    const refused = await grace.command(op, args, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
    expect(refused?.type, op).toBe("Forbidden");
  }
  // guard: the same calls from the owner go through
  expect(await ada.command<Document>("renameDocument", { id: doc.id, name: "plan v2.txt" }, { shape: "{ name }" })).toMatchObject({ name: "plan v2.txt" });

  // a project's files stay in their project
  expect((await grace.query<{ items: unknown[] }>("documents", { projectId: "p2" }, { shape: "{ items { name } }" })).items).toEqual([]);

  // what the panel uses to know whose files it may offer to change
  expect(await grace.query("me", {}, { shape: "{ id name }" })).toMatchObject({ id: "u2", name: "Grace Hopper" });
  // a share cannot even ask: the token names the two operations it may call, and this is not one of them
  const share = await ada.command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  const asked = await client(share.token).query("me", {}, { shape: "{ id name }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(asked?.code).toBe("permission_denied");
});

it("a browser's session cookie reads the bytes without a header, which is how a link opens in a tab", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("in a new tab")), name: "notes.txt" }, { shape: SHAPE });
  const res = await fetch(`${svc.base}${doc.url}`, { headers: { cookie: "keel_session=grace" } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("in a new tab");
  expect((await fetch(`${svc.base}${doc.url}`, { headers: { cookie: "keel_session=nobody" } })).status).toBe(401);
});

it("the same operations on REST routes: ETag from the version, If-Match to change, problems as RFC 9457, a replayed DELETE", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("rest")), name: "rest.txt" }, { shape: SHAPE });
  const as = (who: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${who}`, ...extra });

  // GET: the default view with an ETag; the same ETag back is a 304 with nothing in it
  const got = await fetch(`${svc.base}/documents/${doc.id}`, { headers: as("grace") });
  expect(got.status).toBe(200);
  const etag = got.headers.get("etag")!;
  expect(etag).toMatch(/^"/);
  expect(await got.json()).toMatchObject({ id: doc.id, name: "rest.txt", version: 1 });
  expect((await fetch(`${svc.base}/documents/${doc.id}`, { headers: as("grace", { "if-none-match": etag }) })).status).toBe(304);

  // PATCH with If-Match is a conditional update: the fields sent change, the rest stays, the ETag moves on
  const patched = await fetch(`${svc.base}/documents/${doc.id}`, { method: "PATCH", headers: as("ada", { "content-type": "application/json", "if-match": '"1"' }), body: JSON.stringify({ folder: "contracts", tags: ["Legal"] }) });
  expect(patched.status, await patched.clone().text()).toBe(200);
  expect(patched.headers.get("etag")).toBe('"2"');
  expect(await patched.json()).toMatchObject({ name: "rest.txt", folder: "contracts", tags: ["legal"], version: 2 });
  // a stale If-Match is a 412 problem that carries the document as it is now
  const stale = await fetch(`${svc.base}/documents/${doc.id}`, { method: "PATCH", headers: as("ada", { "content-type": "application/json", "if-match": '"1"' }), body: JSON.stringify({ name: "late.txt" }) });
  expect(stale.status).toBe(412);
  expect(stale.headers.get("content-type")).toContain("application/problem+json");
  const conflict = (await stale.json()) as { title: string; data: { current: { version: number; name: string } } };
  expect(conflict.title).toBe("VersionConflict");
  expect(conflict.data.current).toMatchObject({ version: 2, name: "rest.txt" });
  // a declared error is a problem named after itself
  const notYours = await fetch(`${svc.base}/documents/${doc.id}`, { method: "PATCH", headers: as("grace", { "content-type": "application/json", "if-match": '"2"' }), body: JSON.stringify({ name: "mine.txt" }) });
  expect(notYours.status).toBe(422);
  expect(await notYours.json()).toMatchObject({ title: "Forbidden", code: "domain", data: { id: doc.id } });
  // a nullable query's null is an answer, not a missing route
  const none = await fetch(`${svc.base}/documents/nope`, { headers: as("ada") });
  expect(none.status).toBe(200);
  expect(await none.json()).toBeNull();

  // QUERY: a page, by body, and the same policy as the batch
  const listed = await fetch(`${svc.base}/documents`, { method: "QUERY", headers: as("grace", { "content-type": "application/json" }), body: JSON.stringify({ projectId: "p1", folder: "contracts" }) });
  expect(listed.status, await listed.clone().text()).toBe(200);
  expect(((await listed.json()) as { items: Array<{ name: string }> }).items.map((d) => d.name)).toEqual(["rest.txt"]);

  // DELETE with an Idempotency-Key: the retry is answered with the first success, not a 404
  const key = crypto.randomUUID();
  const gone = await fetch(`${svc.base}/documents/${doc.id}`, { method: "DELETE", headers: as("ada", { "idempotency-key": key }) });
  expect(gone.status).toBe(200);
  const again = await fetch(`${svc.base}/documents/${doc.id}`, { method: "DELETE", headers: as("ada", { "idempotency-key": key }) });
  expect(again.status).toBe(200);
  expect(again.headers.get("idempotent-replayed")).toBe("true");
  expect(await (await fetch(`${svc.base}/documents/${doc.id}`, { headers: as("ada") })).json()).toBeNull();

  // and the contract is published: every route above is in the OpenAPI document the service generates
  const openapi = (await (await fetch(`${svc.base}/rayfold/openapi.json`)).json()) as { paths: Record<string, Record<string, unknown>> };
  expect(Object.keys(openapi.paths["/documents/{id}"] ?? {}).sort()).toEqual(["delete", "get", "patch"]);
  expect(Object.keys(openapi.paths["/documents"] ?? {})).toEqual(["query"]);
});

it("updateDocument changes what it is sent and nothing else; renameDocument still works until its sunset", async () => {
  const ada = client("ada");
  const F = "{ id name folder tags version }";
  const doc = await ada.command<Document & { folder: string | null; tags: string[] }>("createDocument", { projectId: "p1", upload: await upload("ada", text("x")), name: "a.txt" }, { shape: F });
  const filed = await ada.command<Document & { folder: string | null; tags: string[] }>("updateDocument", { id: doc.id, changes: { folder: "plans", tags: ["Q4"] } }, { shape: F, ifVersion: 1 });
  expect(filed).toMatchObject({ name: "a.txt", folder: "plans", tags: ["q4"], version: 2 });
  const renamed = await ada.command<Document & { folder: string | null; tags: string[] }>("updateDocument", { id: doc.id, changes: { name: "b.txt" } }, { shape: F, ifVersion: 2 });
  expect(renamed).toMatchObject({ name: "b.txt", folder: "plans", tags: ["q4"], version: 3 });
  // read back: the columns not named are as they were
  expect(await ada.query(`document`, { id: doc.id }, { shape: F })).toMatchObject({ name: "b.txt", folder: "plans", tags: ["q4"], version: 3 });
  // null clears a folder, and cannot clear a name
  expect(await ada.command("updateDocument", { id: doc.id, changes: { folder: null } }, { shape: F, ifVersion: 3 })).toMatchObject({ folder: null, version: 4 });
  const noName = await ada.command("updateDocument", { id: doc.id, changes: { name: null } }, { shape: F, ifVersion: 4 }).then(() => null, (e: RayfoldClientError) => e);
  expect(noName?.code).toBe("invalid_argument");
  // the deprecated command is still the same command: a client that has not moved yet is not broken
  expect(await ada.command("renameDocument", { id: doc.id, name: "c.txt" }, { shape: F, ifVersion: 4 })).toMatchObject({ name: "c.txt", version: 5 });
});

it("a share may never delete, even with a token widened to name deleteDocument: the schema's deny is the second gate", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("kept")), name: "kept.txt" }, { shape: SHAPE });
  // a token this service would never mint: the secret is the test's, the ops list is wider than any share's
  const widened = new Capabilities({ secret: "a-test-secret-of-sufficient-length" }).mint({ id: `share:${doc.id}`, documentId: doc.id }, { ops: ["document", "deleteDocument"], ttlMs: 60_000, iss: "documents" });
  const refused = await client(widened).command("deleteDocument", { id: doc.id }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.code).toBe("permission_denied");
  expect(await client(widened).query<Document>("document", { id: doc.id }, { shape: "{ name }" })).toMatchObject({ name: "kept.txt" }); // the token itself works
  // guard: the owner, whom the deny does not name, deletes
  await ada.command("deleteDocument", { id: doc.id }, { shape: "{ id }" });
  expect(await ada.query("document", { id: doc.id }, { shape: "{ id }" })).toBeNull();
});

it("takes the bytes with the document when it is deleted", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("temporary")), name: "draft.txt" }, { shape: SHAPE });
  expect(await readdir(dirs.files)).toHaveLength(1);

  await ada.command("deleteDocument", { id: doc.id }, { shape: "{ id }" });
  expect(await readdir(dirs.files)).toEqual([]);
  expect((await download(doc.url, "ada")).status).toBe(404);
  expect((await svc.sql.query("select 1 from revisions where document_id = $1", [doc.id])).rowCount).toBe(0);
});

it("keeping a document starts the document-kept flow, with a token that reads that document and nothing else", async () => {
  const ada = client("ada");
  // the service defined the flow at start: three steps, the condition and the lock between them
  expect(platform.flows.get("document-kept")?.map((s) => s.name)).toEqual(["extract", "index", "notify"]);
  expect(platform.flows.get("document-kept")?.[1]).toMatchObject({ after: ["extract"], when: { step: "extract", path: "characters", notEquals: 0 }, lock: "doc:{documentId}" });

  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("the whole contract")), name: "contract.txt" }, { shape: SHAPE });
  const other = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("not this one")), name: "other.txt" }, { shape: SHAPE });

  // one run per revision, keyed so a retry or a second instance cannot start it twice
  const run = await until("the run to be started", async () => platform.runs.find((r) => r.name === "document-kept" && r.key === `${doc.id}:1`));
  const steps = platform.jobs.filter((j) => j.flowRun === run.id);
  expect(steps.map((j) => [j.step, j.queue, j.state])).toEqual([
    ["extract", "extract-text", "ready"],
    ["index", "index-file", "waiting"],
    ["notify", "notify-workspace", "waiting"],
  ]);
  expect(steps[0]?.lock).toBe(`doc:${doc.id}`);
  const payload = steps[0]!.payload as { documentId: string; projectId: string; name: string; contentType: string; url: string; fetchUrl: string };
  expect(payload).toMatchObject({ documentId: doc.id, projectId: "p1", name: "contract.txt", contentType: "text/plain", url: doc.url });

  // the worker fetches the bytes with what the job carries, and nothing else: no session, no ops token
  expect(await (await fetch(payload.fetchUrl)).text()).toBe("the whole contract");
  const token = new URL(payload.fetchUrl).searchParams.get("token")!;
  expect(token.startsWith("rfcap1.")).toBe(true);
  expect((await download(other.url, token)).status).toBe(404);

  // a new version is a new run, whose extract step waits its turn behind the first version's lock
  await ada.command<Document>("replaceContent", { id: doc.id, upload: await upload("ada", text("the whole contract, signed")) }, { shape: SHAPE });
  const second = await until("the second run", async () => platform.runs.find((r) => r.key === `${doc.id}:2`));
  const extract2 = platform.jobs.find((j) => j.flowRun === second.id && j.step === "extract")!;
  expect(await (await fetch((extract2.payload as { fetchUrl: string }).fetchUrl)).text()).toBe("the whole contract, signed");
  expect(extract2.lock).toBe(`doc:${doc.id}`);
});

it("the platform's upload limit applies while the service runs, and a refused upload leaves no bytes", async () => {
  // the value travels over a live query; the service applies it the moment it arrives, without a restart, and says
  // so on its log, which is how this waits for it without an upload landing before the limit does
  const applied = (value: string) =>
    until(`uploads.maxBytes=${value} to reach the service`, () => platform.logs.some((l) => l.service === "documents" && l.body === `configuration: uploads.maxBytes=${value}`) || undefined);
  try {
    await configure("uploads.maxBytes", "10");
    await applied("10");
    const refused = await client("ada")
      .command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("eleven bytes")), name: "big.txt" }, { shape: SHAPE })
      .then(() => null, (err: RayfoldClientError) => err);
    expect(refused).toMatchObject({ code: "domain", type: "UploadTooLarge", data: { size: 12, limit: 10 } });
    expect(await readdir(dirs.files)).toEqual([]);

    // guard: under the limit is kept, and raising the limit lets the same bytes through, still without a restart
    const small = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("ten bytes!")), name: "small.txt" }, { shape: SHAPE });
    expect(small.size).toBe(10);
    await configure("uploads.maxBytes", String(25 * 1024 * 1024));
    await applied(String(25 * 1024 * 1024));
    const kept = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("eleven bytes")), name: "big.txt" }, { shape: SHAPE });
    expect(kept.size).toBe(12);
    expect(await readdir(dirs.files)).toHaveLength(2);
  } finally {
    await operator().command("removeConfig", { app: "documents", environment: "test", key: "uploads.maxBytes" }, { shape: "{ key }", key: crypto.randomUUID() });
  }
});

it("a share stops working when it expires: neither the document nor its bytes", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("for a while")), name: "contract.txt" }, { shape: SHAPE });
  // the token shareDocument mints, minted two hours ago for the hour a share may live at most
  const expired = new Capabilities({ secret: "a-test-secret-of-sufficient-length", now: () => Date.now() - 2 * 60 * 60 * 1000 }).mint(
    { id: `share:${doc.id}`, documentId: doc.id },
    { ops: SHARED_OPS, ttlMs: 60 * 60 * 1000, iss: "documents" },
  );
  const refused = await client(expired).query("document", { id: doc.id }, { shape: "{ name }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.code).toBe("unauthenticated");
  expect((await download(doc.url, expired)).status).toBe(401);

  // guard: a share minted now, by the service, reads both
  const share = await client("ada").command<Share>("shareDocument", { id: doc.id }, { shape: "{ token }" });
  expect(await client(share.token).query<Document>("document", { id: doc.id }, { shape: "{ name }" })).toEqual({ $type: "Document", name: "contract.txt" });
  expect(await (await download(doc.url, share.token)).text()).toBe("for a while");
});

it("a platform that is down does not fail the upload, and the next document starts its run once it is back", async () => {
  const port = Number(new URL(platform.url).port);
  await platform.stop();
  try {
    const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("kept anyway")), name: "offline.txt" }, { shape: SHAPE });
    expect(doc).toMatchObject({ name: "offline.txt", size: 11, version: 1 });
    expect(await (await download(doc.url, "ada")).text()).toBe("kept anyway");
    expect(await readdir(dirs.files)).toHaveLength(1);
  } finally {
    // back where it was, and as the service left it: the flow it defined when it started
    platform = await startStandInConsole(Date.now, port);
    await operator().command("defineFlow", { name: DOCUMENT_KEPT, steps: DOCUMENT_KEPT_STEPS }, { shape: "{ name }", key: crypto.randomUUID() });
  }
  // guard: with the platform back, a document starts its run again
  const next = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("online")), name: "online.txt" }, { shape: SHAPE });
  expect(await until("the run to be started", () => platform.runs.find((r) => r.key === `${next.id}:1`))).toMatchObject({ name: DOCUMENT_KEPT });
});

it("says who it is and what it is doing", async () => {
  await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("one")), name: "draft.txt" }, { shape: SHAPE });

  const stats = await fetch(`${svc.base}/rayfold/stats`, { headers: { authorization: `Bearer ${svc.opsToken}` } });
  expect(stats.status).toBe(200);
  const body = (await stats.json()) as { identity: { name: string }; counters?: Array<{ name: string }> };
  expect(body.identity.name).toBe("documents");

  // guard: the route is not open, and it is not advertised to someone without the token
  expect((await fetch(`${svc.base}/rayfold/stats`)).status).toBe(403);
});

it("tells a browser on another origin that an upload is allowed", async () => {
  // what a browser sends before an upload from a page on a different origin. it never appears in a same-origin
  // test, and a header missing from the answer fails the whole upload before the server sees a byte.
  const res = await fetch(`${svc.base}/rayfold/uploads`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:4200",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,rayfold-upload-name,rayfold-upload-type",
    },
  });
  expect(res.status).toBe(204);
  const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(/,\s*/);
  expect(allowed).toContain("rayfold-upload-name");
  expect(allowed).toContain("rayfold-upload-type");
  expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4200");

  // guard: an origin the fleet does not allow is answered with the fleet's own, which the browser compares with the
  // page's and refuses: never the caller's echoed back, which would be a blanket yes
  const foreign = await fetch(`${svc.base}/rayfold/uploads`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  expect(foreign.headers.get("access-control-allow-origin")).toBe("http://localhost:4200");
});

/** RFC 3339 in UTC with milliseconds: what `Date.prototype.toISOString` writes, and what the schema's Instant is. */
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

it("sends every Instant as RFC 3339 in UTC, and the newest document is still first", async () => {
  // either side of the moment epoch milliseconds gained a digit: as numbers written out as text these two sort the
  // wrong way round, so the order below holds only because the column stays a number and the wire is RFC 3339
  await svc.sql.query(
    `insert into documents (id, name, project_id, content_type, size, url, version, updated_at, owner_id) values
       ('dOld', 'old.txt', 'p1', 'text/plain', 1, '/files/rOld', 1, 999999999999, 'u1'),
       ('dNew', 'new.txt', 'p1', 'text/plain', 1, '/files/rNew', 1, 1000000000000, 'u1')`,
  );
  await svc.sql.query("insert into revisions (id, document_id, version, size, url, at, by_id) values ('rOld', 'dOld', 1, 1, '/files/rOld', 999999999999, 'u1')");
  await svc.sql.query("insert into notes (id, document_id, body, at, by_id) values ('n1', 'dOld', 'kept', 1767225600000, 'u2')");
  const ada = client("ada");

  const listed = await ada.query<{ items: Array<{ id: string; updatedAt: string }> }>("documents", { projectId: "p1" }, { shape: "{ items { id updatedAt } }" });
  expect(listed.items.map((d) => [d.id, d.updatedAt])).toEqual([
    ["dNew", "2001-09-09T01:46:40.000Z"],
    ["dOld", "2001-09-09T01:46:39.999Z"],
  ]);
  // guard: compared as instants the order is newest first, which the numbers' own text would have got backwards
  expect(Date.parse(listed.items[0]!.updatedAt)).toBeGreaterThan(Date.parse(listed.items[1]!.updatedAt));
  expect(String(1000000000000) < String(999999999999)).toBe(true);

  const revisions = await ada.query<{ items: Array<{ at: string }> }>("revisions", { documentId: "dOld" }, { shape: "{ items { at } }" });
  expect(revisions.items.map((r) => r.at)).toEqual(["2001-09-09T01:46:39.999Z"]);
  const notes = await ada.query<{ items: Array<{ at: string }> }>("notes", { documentId: "dOld" }, { shape: "{ items { at } }" });
  expect(notes.items.map((n) => n.at)).toEqual(["2026-01-01T00:00:00.000Z"]);

  // what a command answers is the same form, and names the same instant the column keeps
  const note = await ada.command<{ id: string; at: string }>("addNote", { documentId: "dOld", body: "and another" }, { shape: "{ id at }" });
  const { rows: noteRows } = await svc.sql.query("select at from notes where id = $1", [note.id]);
  expect(note.at).toMatch(RFC3339_UTC);
  expect(note.at).toBe(new Date(Number(noteRows[0]!["at"])).toISOString());

  // the event another service hears carries its Instant the same way: listened for on the relay's own channel
  const listener = await svc.sql.connect();
  const heard = signal<{ at: unknown }>();
  listener.on("notification", (n) => {
    const event = (JSON.parse(n.payload ?? "{}") as { event?: { name: string; payload: { at: unknown } } }).event;
    if (event?.name === "DocumentFiled") heard.fire(event.payload);
  });
  try {
    await listener.query("listen rayfold");
    const moved = await ada.command<{ updatedAt: string }>("moveDocument", { id: "dOld", folder: "kept" }, { shape: "{ updatedAt }", ifVersion: 1 });
    const { rows: docRows } = await svc.sql.query("select updated_at from documents where id = 'dOld'");
    expect(moved.updatedAt).toBe(new Date(Number(docRows[0]!["updated_at"])).toISOString());
    expect((await heard.wait("DocumentFiled on the relay")).at).toMatch(RFC3339_UTC);
  } finally {
    await listener.query("unlisten rayfold");
    listener.release();
  }

  const share = await ada.command<{ expiresAt: string }>("shareDocument", { id: "dOld", ttlMs: 60_000 }, { shape: "{ expiresAt }" });
  expect(share.expiresAt).toMatch(RFC3339_UTC);
});

type Paged = { items: Array<{ id: string }>; total: number; hasMore: boolean; cursor: string | null };
/** Every page of a list, by its own cursor, until it says there are no more. */
async function walk(op: string, args: Record<string, unknown>, first: number): Promise<{ pages: string[][]; totals: number[]; more: boolean[] }> {
  const pages: string[][] = [];
  const totals: number[] = [];
  const more: boolean[] = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const page: Paged = await client("ada").query<Paged>(op, { ...args, page: { first, ...(after ? { after } : {}) } }, { shape: "{ items { id } total hasMore cursor }" });
    pages.push(page.items.map((x) => x.id));
    totals.push(page.total);
    more.push(page.hasMore);
    if (!page.hasMore) return { pages, totals, more };
    after = page.cursor;
  }
  throw new Error(`${op} never said it was done`);
}

it("every list pages by its cursor to the end: each row once, in order, a total for the filter, and hasMore false on the last page", async () => {
  await svc.sql.query(
    `insert into documents (id, name, project_id, content_type, size, url, version, updated_at, owner_id, folder) values
       ('dA', 'a.txt', 'p1', 'text/plain', 1, '/files/rA', 3, 3000, 'u1', 'plans'),
       ('dB', 'b.txt', 'p1', 'text/plain', 1, '/files/rB', 1, 2000, 'u2', 'plans'),
       ('dC', 'c.txt', 'p1', 'text/plain', 1, '/files/rC', 1, 1000, 'u1', 'plans'),
       ('dD', 'd.txt', 'p1', 'text/plain', 1, '/files/rD', 1, 500, 'u1', 'plans/old')`,
  );
  await svc.sql.query("insert into revisions (id, document_id, version, size, url, at, by_id) values ('r1','dA',1,1,'/files/r1',1000,'u1'),('r2','dA',2,1,'/files/r2',2000,'u2'),('r3','dA',3,1,'/files/r3',3000,'u1')");
  await svc.sql.query("insert into notes (id, document_id, body, at, by_id) values ('nZ','dA','first',1000,'u1'),('nY','dA','second',2000,'u2'),('nX','dA','third',3000,'u3')");

  // a folder is that folder, not everything under it
  expect(await walk("documents", { projectId: "p1", folder: "plans" }, 2)).toEqual({ pages: [["dA", "dB"], ["dC"]], totals: [3, 3], more: [true, false] });
  expect(await walk("revisions", { documentId: "dA" }, 2)).toEqual({ pages: [["r3", "r2"], ["r1"]], totals: [3, 3], more: [true, false] });
  expect(await walk("notes", { documentId: "dA" }, 2)).toEqual({ pages: [["nZ", "nY"], ["nX"]], totals: [3, 3], more: [true, false] });
  // guard: a page that holds everything says so
  expect(await walk("documents", { projectId: "p1" }, 4)).toEqual({ pages: [["dA", "dB", "dC", "dD"]], totals: [4], more: [false] });
  // each row's person, loaded once for the page, is that row's own
  const owners = await client("ada").query<{ items: Array<{ id: string; owner: { name: string } }> }>("documents", { projectId: "p1" }, { shape: "{ items { id owner { name } } }" });
  expect(owners.items.map((d) => [d.id, d.owner.name])).toEqual([["dA", "Ada Lovelace"], ["dB", "Grace Hopper"], ["dC", "Ada Lovelace"], ["dD", "Ada Lovelace"]]);
  const by = await client("ada").query<{ items: Array<{ id: string; by: { name: string } }> }>("revisions", { documentId: "dA" }, { shape: "{ items { id by { name } } }" });
  expect(by.items.map((r) => [r.id, r.by.name])).toEqual([["r3", "Ada Lovelace"], ["r2", "Grace Hopper"], ["r1", "Ada Lovelace"]]);
});

it("an upload is consumed by the document it became: naming it again is UploadGone", async () => {
  const id = await upload("ada", text("once"));
  await client("ada").command<Document>("createDocument", { projectId: "p1", upload: id, name: "once.txt" }, { shape: SHAPE });
  const again = await client("ada").command("createDocument", { projectId: "p1", upload: id, name: "twice.txt" }, { shape: SHAPE }).then(() => null, (e: RayfoldClientError) => e);
  expect(again).toMatchObject({ code: "domain", type: "UploadGone", data: { upload: id } });
  expect(await readdir(dirs.files)).toHaveLength(1);
});

it("a dry run of every change says what would happen and writes nothing; the real one writes", async () => {
  const ada = client("ada");
  const F = "{ id name folder tags version }";
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("x")), name: "a.txt" }, { shape: F });
  const dry = async (op: string, args: Record<string, unknown>) => ada.command(op, { id: doc.id, ...args }, { shape: F, ifVersion: 1, simulate: true });
  expect(await dry("updateDocument", { changes: { name: "b.txt", folder: "plans" } })).toMatchObject({ name: "b.txt", folder: "plans", version: 2 });
  expect(await dry("renameDocument", { name: "c.txt" })).toMatchObject({ name: "c.txt", version: 2 });
  expect(await dry("moveDocument", { folder: "elsewhere" })).toMatchObject({ folder: "elsewhere", version: 2 });
  expect(await dry("tagDocument", { tags: ["Legal"] })).toMatchObject({ tags: ["legal"], version: 2 });
  expect(await ada.query("document", { id: doc.id }, { shape: F })).toEqual({ $type: "Document", id: doc.id, name: "a.txt", folder: null, tags: [], version: 1 });
  // the deprecated rename is a real rename, read back
  await ada.command("renameDocument", { id: doc.id, name: "c.txt" }, { shape: F, ifVersion: 1 });
  expect(await ada.query("document", { id: doc.id }, { shape: F })).toEqual({ $type: "Document", id: doc.id, name: "c.txt", folder: null, tags: [], version: 2 });
  // and a stale one is refused like every other change
  const stale = await ada.command("renameDocument", { id: doc.id, name: "d.txt" }, { shape: F, ifVersion: 1 }).then(() => null, (e: RayfoldClientError) => e);
  expect(stale).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  // tags cannot be nulled any more than a name can, and a blank tag is no tag
  const noTags = await ada.command("updateDocument", { id: doc.id, changes: { tags: null } }, { shape: F, ifVersion: 2 }).then(() => null, (e: RayfoldClientError) => e);
  expect(noTags).toMatchObject({ code: "invalid_argument", message: "updateDocument().changes: name and tags cannot be null" });
  expect(await ada.command("updateDocument", { id: doc.id, changes: { tags: ["", "  ", "Q4"] } }, { shape: F, ifVersion: 2 })).toMatchObject({ tags: ["q4"], version: 3 });
});

it("a list open on a folder or a tag hears a document filed into it or tagged with it", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("x")), name: "a.txt" }, { shape: SHAPE });
  const inFolder = signal<{ items: Array<{ name: string }> }>();
  const withTag = signal<{ items: Array<{ name: string }> }>();
  const stops = [
    client("grace").live<{ items: Array<{ name: string }> }>("documents", { projectId: "p1", folder: "plans" }, { shape: "{ items { name } }" }, (d) => inFolder.fire(d), (e) => {
      throw e;
    }),
    client("grace").live<{ items: Array<{ name: string }> }>("documents", { projectId: "p1", tag: "legal" }, { shape: "{ items { name } }" }, (d) => withTag.fire(d), (e) => {
      throw e;
    }),
  ];
  try {
    expect((await inFolder.wait("the folder's first answer")).items).toEqual([]);
    expect((await withTag.wait("the tag's first answer")).items).toEqual([]);
    await ada.command("updateDocument", { id: doc.id, changes: { folder: "plans" } }, { shape: "{ id }", ifVersion: 1 });
    expect((await inFolder.wait("the folder to hear the filing")).items).toEqual([{ $type: "Document", name: "a.txt" }]);
    await ada.command("tagDocument", { id: doc.id, tags: ["legal"] }, { shape: "{ id }", ifVersion: 2 });
    expect((await withTag.wait("the tag to hear the tagging")).items).toEqual([{ $type: "Document", name: "a.txt" }]);
  } finally {
    for (const stop of stops) stop();
  }
});

it("what another service hears: a change by updateDocument, and a remark cut to its first eighty characters", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("x")), name: "a.txt" }, { shape: SHAPE });
  const listener = await svc.sql.connect();
  const heard = signal<{ name: string; payload: Record<string, unknown> }>();
  listener.on("notification", (n) => {
    const event = (JSON.parse(n.payload ?? "{}") as { event?: { name: string; payload: Record<string, unknown> } }).event;
    if (event?.name === "DocumentChanged" || event?.name === "DocumentNoted") heard.fire(event);
  });
  try {
    await listener.query("listen rayfold");
    await ada.command("updateDocument", { id: doc.id, changes: { name: "b.txt" } }, { shape: "{ id }", ifVersion: 1 });
    // a new name on the same bytes: the fleet is told it is not a new version
    expect(await heard.wait("DocumentChanged")).toEqual({ name: "DocumentChanged", payload: { documentId: doc.id, projectId: "p1", name: "b.txt", version: 2, byId: "u1", revision: false } });
    const body = `${"a".repeat(79)}bc and the rest`;
    await ada.command("addNote", { documentId: doc.id, body }, { shape: "{ id }" });
    expect(await heard.wait("DocumentNoted")).toEqual({ name: "DocumentNoted", payload: { documentId: doc.id, projectId: "p1", name: "b.txt", excerpt: `${"a".repeat(79)}b`, byId: "u1" } });
  } finally {
    await listener.query("unlisten rayfold");
    listener.release();
  }
});

it("what another service hears of new bytes, a new name, and a change that is neither", async () => {
  const ada = client("ada");
  const listener = await svc.sql.connect();
  const heard: Array<Record<string, unknown>> = [];
  const noted = signal<true>();
  listener.on("notification", (n) => {
    const event = (JSON.parse(n.payload ?? "{}") as { event?: { name: string; payload: Record<string, unknown> } }).event;
    if (event?.name === "DocumentChanged") heard.push(event.payload);
    // a remark after everything else: once it is heard, every DocumentChanged before it has been too
    if (event?.name === "DocumentNoted") noted.fire(true);
  });
  try {
    await listener.query("listen rayfold");
    const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("one")), name: "a.txt" }, { shape: SHAPE });
    await ada.command("replaceContent", { id: doc.id, upload: await upload("ada", text("two")) }, { shape: "{ id }", ifVersion: 1 });
    await ada.command("renameDocument", { id: doc.id, name: "c.txt" }, { shape: "{ id }", ifVersion: 2 });
    // guard: a folder and tags alone are not a change the fleet hears as DocumentChanged
    await ada.command("updateDocument", { id: doc.id, changes: { folder: "contracts", tags: ["q4"] } }, { shape: "{ id }", ifVersion: 3 });
    await ada.command("updateDocument", { id: doc.id, changes: { name: "d.txt", folder: "legal" } }, { shape: "{ id }", ifVersion: 4 });
    await ada.command("addNote", { documentId: doc.id, body: "done" }, { shape: "{ id }" });
    await noted.wait("the remark that comes after them all");
    expect(heard.map((p) => [p["name"], p["version"], p["revision"]])).toEqual([
      ["a.txt", 1, true],
      ["a.txt", 2, true],
      ["c.txt", 3, false],
      ["d.txt", 5, false],
    ]);
  } finally {
    await listener.query("unlisten rayfold");
    listener.release();
  }
});

it("a share lasts the time it was asked for", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("x")), name: "a.txt" }, { shape: SHAPE });
  const before = Date.now();
  const share = await client("ada").command<{ expiresAt: string }>("shareDocument", { id: doc.id, ttlMs: 60_000 }, { shape: "{ expiresAt }" });
  const after = Date.now();
  // bounded by the clock read either side of the call, so nothing here depends on how long it took
  expect(Date.parse(share.expiresAt)).toBeGreaterThanOrEqual(before + 60_000);
  expect(Date.parse(share.expiresAt)).toBeLessThanOrEqual(after + 60_000);
});

it("the job's token reads the document for the extract step and nothing else: not its history, not the share's own operations", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("for the worker")), name: "w.txt" }, { shape: SHAPE });
  const run = await until("the run to be started", async () => platform.runs.find((r) => r.key === `${doc.id}:1`));
  const fetchUrl = (platform.jobs.find((j) => j.flowRun === run.id && j.step === "extract")!.payload as { fetchUrl: string }).fetchUrl;
  const token = new URL(fetchUrl).searchParams.get("token")!;
  expect(await client(token).query("document", { id: doc.id }, { shape: "{ name }" })).toEqual({ $type: "Document", name: "w.txt" });
  for (const [op, args, shape] of [["revisions", { documentId: doc.id }, "{ total }"], ["shared", {}, "{ id }"]] as const) {
    const refused = await client(token).query(op, args, { shape }).then(() => null, (e: RayfoldClientError) => e);
    expect(refused?.code, op).toBe("permission_denied");
  }
});

it("the bytes are served as what they are, never sniffed; bytes missing from the volume are a 404; only a GET reads them", async () => {
  const doc = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("# notes"), "text/markdown"), name: "notes.md" }, { shape: SHAPE });
  const res = await download(doc.url, "ada");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/markdown");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).toBe("# notes");
  // a POST to the same address is not a read of it
  const posted = await fetch(`${svc.base}${doc.url}`, { method: "POST", headers: { authorization: "Bearer ada" } });
  expect(posted.status).toBe(404);
  expect(await posted.text()).not.toBe("# notes");
  // the row is there and the file is not: a clean 404 before any status line, not a broken stream
  await rm(join(dirs.files, doc.url.split("/").pop()!));
  const gone = await download(doc.url, "ada");
  expect(gone.status).toBe(404);
  expect(await gone.text()).toBe("");
});

it("a version guard on every write: a change that lost the race to another lands nowhere", async () => {
  const store = new DocumentStore(svc.sql);
  await svc.sql.query("insert into documents (id, name, project_id, content_type, size, url, version, updated_at, owner_id) values ('dV', 'v.txt', 'p1', 'text/plain', 1, '/files/rV', 2, 1000, 'u1')");
  const doc = (await store.document("dV"))!;
  const at = "2026-10-01T00:00:00.000Z";
  // each as the losing writer would call it: having read version 1, when the row is at 2
  expect(await store.replace({ ...doc, size: 9, version: 2 }, { id: "rLost", documentId: "dV", version: 2, size: 9, url: "/files/rLost", at, byId: "u1" }, 1)).toBe(false);
  expect(await store.update({ ...doc, name: "lost.txt", version: 2 }, 1)).toBe(false);
  expect(await store.rename("dV", "lost.txt", 1, at)).toBe(false);
  expect(await store.file("dV", "lost", 1, at)).toBe(false);
  expect(await store.tag("dV", ["lost"], 1, at)).toBe(false);
  expect(await store.document("dV")).toEqual(doc);
  expect((await svc.sql.query("select 1 from revisions where id = 'rLost'")).rowCount).toBe(0);
  // guard: the writer that read version 2 lands
  expect(await store.tag("dV", ["won"], 2, at)).toBe(true);
  expect(await store.document("dV")).toMatchObject({ tags: ["won"], version: 3 });
});

it("a document that cannot be written leaves its connection clean for the next one", async () => {
  // one connection, so the next write is certain to get the one the failure used
  const one = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    const store = new DocumentStore(one);
    const at = "2026-10-01T00:00:00.000Z";
    const doc = { id: "dX", name: "x.txt", projectId: "p1", contentType: "text/plain", size: 1, url: "/files/rX", version: 1, updatedAt: at, ownerId: "nobody", folder: null, tags: [] };
    await expect(store.create(doc, { id: "rX", documentId: "dX", version: 1, size: 1, url: "/files/rX", at, byId: "nobody" })).rejects.toThrow(/foreign key/);
    await store.create({ ...doc, ownerId: "u1" }, { id: "rX", documentId: "dX", version: 1, size: 1, url: "/files/rX", at, byId: "u1" });
    expect(await store.document("dX")).toMatchObject({ id: "dX", ownerId: "u1" });
  } finally {
    await one.end();
  }
});

it("an instance reads its configuration before it serves: the boot line already has the console's value", async () => {
  await configure("uploads.maxBytes", "10");
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  const root = await mkdtemp(join(tmpdir(), "documents-boot-"));
  // a console slow to answer: the instance waits for it rather than starting on its defaults
  const release = platform.holdConfig();
  let started = false;
  const starting = startTestService("documents", { FILES_DIR: join(root, "files"), UPLOADS_DIR: join(root, "uploads"), CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token, APP_ENVIRONMENT: "test" }, 5).then((s) => {
    started = true;
    return s;
  });
  // the configuration query has been asked and is held: the instance is waiting on it
  await until("the instance to ask for its configuration", () => (platform.server.changes.size >= 2 ? true : undefined));
  expect(started).toBe(false);
  release();
  const other = await starting;
  try {
    expect(lines.filter((l) => l.startsWith("[documents] configuration from"))).toEqual([`[documents] configuration from ${platform.url} (test): {"uploads.maxBytes":"10"}`]);
  } finally {
    vi.restoreAllMocks();
    await other.stop();
    await rm(root, { recursive: true, force: true });
    await operator().command("removeConfig", { app: "documents", environment: "test", key: "uploads.maxBytes" }, { shape: "{ key }", key: crypto.randomUUID() });
  }
});

describe("the file store", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "filestore-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  const body = (s: string) => new Blob([s]).stream() as ReadableStream<Uint8Array>;

  it("a name that is not an id is never a path: it is refused, unread, absent", async () => {
    const files = new FileStore(root, "https://cdn.example/files");
    for (const id of ["../escape", "a/b", "a.b", ""]) {
      await expect(files.write(id, body("x")), id).rejects.toThrow(`FileStore: ${JSON.stringify(id)} is not a usable name`);
      expect(files.read(id), id).toBeUndefined();
      expect(await files.has(id), id).toBe(false);
    }
    expect(await readdir(root)).toEqual([]);
    // guard: an id is written, read, and its url is under the base it was given
    expect(await files.write("r_1-A", body("bytes"))).toBe(5);
    expect(await files.has("r_1-A")).toBe(true);
    expect(await new Response(files.read("r_1-A")).text()).toBe("bytes");
    expect(files.url("r_1-A")).toBe("https://cdn.example/files/r_1-A");
  });

  it("bytes that fail on the way in leave no file behind", async () => {
    const files = new FileStore(root);
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("half"));
        c.error(new Error("the upload was cut"));
      },
    });
    await expect(files.write("rBroken", broken)).rejects.toThrow("the upload was cut");
    expect(await readdir(root)).toEqual([]);
    expect(await files.has("rBroken")).toBe(false);
  });
});
