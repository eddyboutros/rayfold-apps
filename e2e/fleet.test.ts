import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { signal, until } from "./wait.ts";

/**
 * Two services, separately deployed, sharing one Postgres and one relay.
 *
 * What is proved here cannot be proved inside either service: something that happens in **documents** reaches a
 * person looking at **workspace**, over the relay, with no shared table, no polling and no webhook. That is the
 * claim a fleet makes, and it is the one nothing else in this repository tests.
 */
let documents: TestService;
let workspace: TestService;
let dirs: { files: string; uploads: string };

const PROJECT = "p1";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-"));
  dirs = { files: join(root, "files"), uploads: join(root, "uploads") };
  // started one after the other, as a deploy starts them: each reads its own configuration and opens its own port
  documents = await startTestService("documents", { FILES_DIR: dirs.files, UPLOADS_DIR: dirs.uploads });
  workspace = await startTestService("workspace");
});

afterAll(async () => {
  await workspace?.stop();
  await documents?.stop();
  await rm(dirs.files, { recursive: true, force: true });
  await rm(dirs.uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  await documents.reset();
  await workspace.reset();
  await rm(dirs.files, { recursive: true, force: true });
});

async function upload(bytes: Uint8Array): Promise<string> {
  const res = await fetch(`${documents.base}/rayfold/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: "Bearer ada", "rayfold-upload-type": "text/plain" },
    body: bytes as BodyInit,
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const text = (s: string) => new TextEncoder().encode(s);

interface Doc {
  id: string;
  version: number;
}
interface Feed {
  items: Array<{ source: string; kind: string; text: string; by?: { name: string } | null }>;
}

it("a document kept in one service shows up on the other service's feed, with who did it", async () => {
  const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("the contract")), name: "contract.txt" }, { shape: "{ id version }" });

  const feed = await until(
    "the document to reach the workspace feed",
    async () => {
      const page = await workspace.client("grace").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
      return page.items.length ? page : undefined;
    },
  );

  // the person is named by the workspace from its own roster: the event carried an id, never a name
  expect(feed.items[0]).toMatchObject({ source: "documents", kind: "document.added", by: { name: "Ada Lovelace" } });
  expect(feed.items[0]?.text).toContain(doc.id);

  // nothing was shared to make that happen: the workspace has no documents table, and never asked for one
  const { rows } = await workspace.sql.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('documents','revisions')",
  );
  expect(rows.map((r) => r["table_name"]).sort()).toEqual(["documents", "revisions"]); // they exist, owned by the other service
  const feedRows = await workspace.sql.query("select source from activity");
  expect(feedRows.rows.every((r) => r["source"] === "documents")).toBe(true);
});

it("a live query on the feed updates when the other service changes something", async () => {
  const ada = workspace.client("ada");
  const lines = signal<Feed>();

  const stop = ada.live<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text } }" }, (data) => lines.fire(data), (e) => {
    throw e;
  });

  try {
    // the first answer is what the query returns now: an empty feed
    expect((await lines.wait("the live query's first answer")).items).toEqual([]);

    // a completely separate service, on its own port, with its own database tables
    const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("a plan")), name: "plan.txt" }, { shape: "{ id version }" });

    const updated = await until("the live query to hear the other service", async () => {
      const next = await lines.wait("a feed update", 1_000).catch(() => undefined);
      return next?.items.length ? next : undefined;
    }, 8_000);

    expect(updated.items[0]).toMatchObject({ source: "documents", kind: "document.added" });
    expect(updated.items[0]?.text).toContain(doc.id);
  } finally {
    stop();
  }
});

it("replacing a document adds a second line, and the feed keeps both in order", async () => {
  const ada = documents.client("ada");
  const doc = await ada.command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("draft one")), name: "plan.txt" }, { shape: "{ id version }" });
  await ada.command<Doc>("replaceContent", { id: doc.id, upload: await upload(text("draft two")) }, { shape: "{ id version }" });

  const feed = await until(
    "both document lines",
    async () => {
      const page = await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text } }" });
      return page.items.length === 2 ? page : undefined;
    },
  );

  // newest first: the replace, then the one that added it
  expect(feed.items.map((i) => i.kind)).toEqual(["document.replaced", "document.added"]);
});

it("the workspace's own work and the other service's sit on one feed, and an open feed hears both", async () => {
  const ada = workspace.client("ada");
  // a feed already open, as a person's screen is: it has to hear this service's own commands, not only the relay.
  // a new row touches no entity the feed has read, so this is what a command's `invOp` patch exists for
  const seen = signal<Feed>();
  const stop = ada.live<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the open feed's first answer")).items).toEqual([]);

    const issue = await ada.command<{ id: string; title: string }>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id title }" });
    expect((await seen.wait("the feed to hear the issue")).items.map((i) => i.kind)).toEqual(["issue.created"]);

    await ada.command("addComment", { issueId: issue.id, body: "waiting on the file" }, { shape: "{ id }" });
    expect((await seen.wait("the feed to hear the comment")).items.map((i) => i.kind)).toEqual(["comment.added", "issue.created"]);

    await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("the contract")), name: "contract.txt" }, { shape: "{ id }" });
    const all = await until("the feed to hear the other service", async () => {
      const next = await seen.wait("a feed update", 1_000).catch(() => undefined);
      return next?.items.length === 3 ? next : undefined;
    }, 8_000);
    expect(all.items.map((i) => `${i.source}:${i.kind}`)).toEqual([
      "documents:document.added",
      "workspace:comment.added",
      "workspace:issue.created",
    ]);
  } finally {
    stop();
  }
});

it("each service answers for itself, and says which it is", async () => {
  for (const [name, svc] of [
    ["documents", documents],
    ["workspace", workspace],
  ] as const) {
    const stats = await fetch(`${svc.base}/rayfold/stats`, { headers: { authorization: `Bearer ${svc.opsToken}` } });
    expect(stats.status, name).toBe(200);
    expect(((await stats.json()) as { identity: { name: string } }).identity.name).toBe(name);

    const ready = await fetch(`${svc.base}/rayfold/ready`);
    expect(ready.status, name).toBe(200);
  }
});

it("two instances of a service react to one event and write one row between them", async () => {
  // as a deploy runs it: a second instance of the workspace, same database, same relay
  const replica = await startTestService("workspace", {}, 2);

  try {
    const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("one copy")), name: "once.txt" }, { shape: "{ id version }" });

    // both instances hear it and both react; only one row may exist, or the feed shows everything twice for
    // every replica anyone deploys
    const feed = await until("the line to reach the feed", async () => {
      const page = await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text } }" });
      return page.items.length ? page : undefined;
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.text).toContain(doc.id);

    // and it stays one: the second instance had time to write its own and did not
    await new Promise((r) => setTimeout(r, 200));
    const { rows } = await workspace.sql.query("select id from activity");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["id"]).toBe(`documents:${doc.id}:1`);

    // guard: the replica is not inert — it serves the same feed, which is why it was listening at all
    const fromReplica = await replica.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { text } }" });
    expect(fromReplica.items).toHaveLength(1);
  } finally {
    await replica.stop();
  }
});
