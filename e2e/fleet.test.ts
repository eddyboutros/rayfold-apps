import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startStandInConsole, type StandInConsole } from "./stand-in-console.ts";
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
let catalogue: TestService;
let platform: StandInConsole;
let dirs: { files: string; uploads: string };

const PROJECT = "p1";

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-"));
  dirs = { files: join(root, "files"), uploads: join(root, "uploads") };
  platform = await startStandInConsole();
  // started one after the other, as a deploy starts them: each reads its own configuration and opens its own port
  documents = await startTestService("documents", { FILES_DIR: dirs.files, UPLOADS_DIR: dirs.uploads, CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token });
  workspace = await startTestService("workspace", { CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token });
  catalogue = await startTestService("catalogue", { CONSOLE_URL: platform.url, CONSOLE_TOKEN: platform.token });
});

afterAll(async () => {
  await catalogue?.stop();
  await workspace?.stop();
  await documents?.stop();
  await platform?.stop();
  await rm(dirs.files, { recursive: true, force: true });
  await rm(dirs.uploads, { recursive: true, force: true });
});

beforeEach(async () => {
  await documents.reset();
  await workspace.reset();
  await catalogue.reset();
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

it("filing, tagging and remarking on a document in one service are lines on the other's feed, each credited", async () => {
  const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("the contract")), name: "contract.txt" }, { shape: "{ id version }" });
  await documents.client("ada").command("moveDocument", { id: doc.id, folder: "contracts" }, { shape: "{ id }", ifVersion: doc.version });
  await documents.client("grace").command("tagDocument", { id: doc.id, tags: ["legal", "q4"] }, { shape: "{ id }", ifVersion: doc.version + 1 });
  await documents.client("noor").command("addNote", { documentId: doc.id, body: "Signed copy is the one to keep." }, { shape: "{ id }" });

  const feed = await until("the three lines to reach the workspace", async () => {
    const page = await workspace.client("grace").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
    return page.items.length === 4 ? page : undefined;
  });
  expect(feed.items.map((i) => [i.kind, i.by?.name, i.text.replace(` (${doc.id})`, "")])).toEqual([
    ["document.noted", "Noor Haddad", "contract.txt: Signed copy is the one to keep."],
    ["document.tagged", "Grace Hopper", "contract.txt: legal q4"],
    ["document.filed", "Ada Lovelace", "contract.txt: contracts"],
    ["document.added", "Ada Lovelace", "contract.txt"],
  ]);
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

it("a document kept in one service is found by a search in another, and the third says so — one flow across three services", async () => {
  // the whole chain, with nothing shared between the services but the platform's flow: documents starts a run with
  // a token that reads this one document; the catalogue works extract and index, fetching the bytes with that
  // token; the workspace works notify and puts a line on the project's feed. the person searching never touched a
  // job or a token.
  const doc = await documents.client("ada").command<Doc>(
    "createDocument",
    { projectId: PROJECT, upload: await upload(text("Wave two moves orders and returns; invoicing stays behind until wave three.")), name: "Rollout notes.txt" },
    { shape: "{ id version }" },
  );

  const found = await until("the catalogue to find the document's text", async () => {
    const page = await catalogue.client("grace").query<{ items: Array<{ $type: string; name: string; url?: string; excerpt?: string }> }>(
      "search",
      { q: "invoicing stays behind" },
      { shape: "{ items { name ...on File { url excerpt } } }" },
    );
    return page.items.length ? page : undefined;
  }, 10_000);
  expect(found.items[0]).toMatchObject({ $type: "File", name: "Rollout notes.txt" });
  expect(found.items[0]?.excerpt).toContain("Wave two moves orders");

  // the url the catalogue hands out is the documents service's own path, which the person's session may open there
  const url = found.items[0]!.url!;
  expect(await (await fetch(`${documents.base}${url}`, { headers: { cookie: "keel_session=grace" } })).text()).toContain("Wave two moves orders");

  // the last step: the workspace's feed says the file became searchable, credited to the product, not a person
  const line = await until("the feed to say the file is searchable", async () => {
    const page = await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
    return page.items.find((i) => i.kind === "document.indexed");
  }, 10_000);
  expect(line).toMatchObject({ source: "catalogue", by: null });
  expect(line.text).toContain("Rollout notes.txt");

  // and Ada, who kept the file in the documents service, is told by the workspace: one notification, hers alone
  const told = await until("Ada to be told her file is searchable", async () => {
    const page = await workspace.client("ada").query<{ items: Array<{ kind: string; text: string; projectId: string }> }>("notifications", {}, { shape: "{ items { kind text projectId } }" });
    return page.items.find((n) => n.kind === "document.indexed");
  }, 10_000);
  expect(told).toMatchObject({ text: "Rollout notes.txt is searchable now", projectId: PROJECT });
  expect((await workspace.client("grace").query<{ total: number }>("notifications", {}, { shape: "{ total }" })).total).toBe(0);

  // what the platform recorded: one run, keyed to the revision, each step done by the service that owns the work
  const run = platform.runs.find((r) => r.key === `${doc.id}:1`)!;
  const steps = platform.jobs.filter((j) => j.flowRun === run.id);
  expect(steps.map((j) => [j.step, j.state, j.worker?.split("-")[0]])).toEqual([
    ["extract", "done", "catalogue"],
    ["index", "done", "catalogue"],
    ["notify", "done", "workspace"],
  ]);
  expect(steps[2]!.result).toEqual({ recorded: true });
});

it("a file with no text is not indexed, and the feed says so: a condition between steps, not an if in a worker", async () => {
  const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(new Uint8Array()), name: "empty.txt" }, { shape: "{ id }" });
  const line = await until("the feed to say there was nothing to index", async () => {
    const page = await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { kind text } }" });
    return page.items.find((i) => i.kind === "document.empty");
  }, 10_000);
  expect(line.text).toContain("empty.txt");
  // nothing became searchable, so nobody is told
  expect((await workspace.client("ada").query<{ total: number }>("notifications", {}, { shape: "{ total }" })).total).toBe(0);
  const run = platform.runs.find((r) => r.key === `${doc.id}:1`)!;
  expect(platform.jobs.filter((j) => j.flowRun === run.id).map((j) => [j.step, j.state])).toEqual([
    ["extract", "done"],
    ["index", "skipped"],
    ["notify", "done"],
  ]);
  expect((await catalogue.sql.query("select 1 from files where id = $1", [doc.id])).rowCount).toBe(0);
});

it("each service answers for itself, and says which it is", async () => {
  for (const [name, svc] of [
    ["documents", documents],
    ["workspace", workspace],
    ["catalogue", catalogue],
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
