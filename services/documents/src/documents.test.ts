import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { Capabilities } from "@rayfold/server";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { startStandInConsole, type StandInConsole } from "../../../e2e/stand-in-console.ts";
import { until } from "../../../e2e/wait.ts";

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
  await configure("uploads.maxBytes", "10");
  // the value travels over a live query; the service applies it the moment it arrives, without a restart
  const refused = await until("the limit to reach the service", async () => {
    const e = await client("ada")
      .command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("eleven bytes")), name: "big.txt" }, { shape: SHAPE })
      .then(() => null, (err: RayfoldClientError) => err);
    return e?.type === "UploadTooLarge" ? e : undefined;
  });
  expect(refused.data).toMatchObject({ size: 12, limit: 10 });
  expect(await readdir(dirs.files)).toEqual([]);

  // guard: under the limit is kept, and raising the limit lets the same bytes through, still without a restart
  const small = await client("ada").command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("ten bytes!")), name: "small.txt" }, { shape: SHAPE });
  expect(small.size).toBe(10);
  await configure("uploads.maxBytes", String(25 * 1024 * 1024));
  const kept = await until("the raised limit to reach the service", async () =>
    client("ada")
      .command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("eleven bytes")), name: "big.txt" }, { shape: SHAPE })
      .then((d) => d, () => undefined),
  );
  expect(kept.size).toBe(12);
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

  // guard: an origin the fleet does not allow gets Rayfold's own refusal, not a blanket yes
  const foreign = await fetch(`${svc.base}/rayfold/uploads`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  expect(foreign.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
});
