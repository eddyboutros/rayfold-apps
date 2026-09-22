import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RayfoldClientError } from "@rayfold/client";
import { startTestService, type TestService } from "../../../e2e/harness.ts";

/**
 * The documents service as it runs: a real Postgres, a real port, the real client. What is asserted is what the
 * service promises — the bytes are a file, the row carries only their URL, a share reads one document, and a
 * losing replace leaves nothing behind.
 */
let svc: TestService;
let dirs: { files: string; uploads: string };

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "documents-"));
  dirs = { files: join(root, "files"), uploads: join(root, "uploads") };
  svc = await startTestService("documents", { FILES_DIR: dirs.files, UPLOADS_DIR: dirs.uploads });
});

afterAll(async () => {
  await svc?.stop();
  await rm(dirs.files, { recursive: true, force: true });
  await rm(dirs.uploads, { recursive: true, force: true });
});

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
  expect(share.ops).toEqual(["document", "revisions"]);

  const guest = client(share.token);
  expect(await guest.query<Document>("document", { id: doc.id }, { shape: "{ name }" })).toMatchObject({ name: "contract.txt" });
  expect(await (await download(doc.url, share.token)).text()).toBe("for the lawyer");

  // a refused entity at a nullable position is not there, so a share cannot be used to learn what else exists
  expect(await guest.query<Document | null>("document", { id: other.id }, { shape: "{ name }" })).toBeNull();
  expect((await download(other.url, share.token)).status).toBe(404);
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

it("takes the bytes with the document when it is deleted", async () => {
  const ada = client("ada");
  const doc = await ada.command<Document>("createDocument", { projectId: "p1", upload: await upload("ada", text("temporary")), name: "draft.txt" }, { shape: SHAPE });
  expect(await readdir(dirs.files)).toHaveLength(1);

  await ada.command("deleteDocument", { id: doc.id }, { shape: "{ id }" });
  expect(await readdir(dirs.files)).toEqual([]);
  expect((await download(doc.url, "ada")).status).toBe(404);
  expect((await svc.sql.query("select 1 from revisions where document_id = $1", [doc.id])).rowCount).toBe(0);
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
