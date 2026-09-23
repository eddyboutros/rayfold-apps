import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
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

/**
 * Every job the platform holds is finished. A document kept starts a flow that runs on after the test's last
 * assertion; left running, its workers write the line it ends with onto the next test's feed.
 */
const settled = () => until("every flow run to finish", () => platform.jobs.every((j) => ["done", "skipped", "dead"].includes(j.state)) || undefined, 15_000);

beforeEach(async () => {
  await documents.reset();
  await workspace.reset();
  await catalogue.reset();
  await rm(dirs.files, { recursive: true, force: true });
});
afterEach(() => settled());

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

  const line = await until("the document to reach the workspace feed", async () => {
    const page = await workspace.client("grace").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
    return page.items.find((i) => i.kind === "document.added");
  });

  // the person is named by the workspace from its own roster: the event carried an id, never a name
  expect(line).toEqual({ $type: "Activity", source: "documents", kind: "document.added", text: `contract.txt (${doc.id})`, by: { $type: "Member", name: "Ada Lovelace" } });

  // nothing was shared to make that happen: the workspace has no documents table, and never asked for one
  const { rows } = await workspace.sql.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('documents','revisions')",
  );
  expect(rows.map((r) => r["table_name"]).sort()).toEqual(["documents", "revisions"]); // they exist, owned by the other service
  // every row on the feed came over the relay or the platform: the document's own line, and the one its flow ends with
  await settled();
  const feedRows = await workspace.sql.query("select source, kind from activity order by source");
  expect(feedRows.rows).toEqual([
    { source: "catalogue", kind: "document.indexed" },
    { source: "documents", kind: "document.added" },
  ]);
});

it("filing, tagging and remarking on a document in one service are lines on the other's feed, each credited", async () => {
  const doc = await documents.client("ada").command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("the contract")), name: "contract.txt" }, { shape: "{ id version }" });
  await documents.client("ada").command("moveDocument", { id: doc.id, folder: "contracts" }, { shape: "{ id }", ifVersion: doc.version });
  await documents.client("grace").command("tagDocument", { id: doc.id, tags: ["legal", "q4"] }, { shape: "{ id }", ifVersion: doc.version + 1 });
  await documents.client("noor").command("addNote", { documentId: doc.id, body: "Signed copy is the one to keep." }, { shape: "{ id }" });

  // the documents service's own lines; the catalogue's lands when the file's flow ends, on its own time
  const lines = await until("the four lines to reach the workspace", async () => {
    const page = await workspace.client("grace").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
    const mine = page.items.filter((i) => i.source === "documents");
    return mine.length === 4 ? mine : undefined;
  });
  expect(lines.map((i) => [i.kind, i.by?.name, i.text.replace(` (${doc.id})`, "")])).toEqual([
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

    const added = await until("the live query to hear the other service", async () => {
      const next = await lines.wait("a feed update", 1_000).catch(() => undefined);
      return next?.items.find((i) => i.kind === "document.added");
    }, 8_000);

    expect(added).toEqual({ $type: "Activity", source: "documents", kind: "document.added", text: `plan.txt (${doc.id})` });
  } finally {
    stop();
  }
});

it("replacing a document adds a second line, and the feed keeps both in order", async () => {
  const ada = documents.client("ada");
  const doc = await ada.command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("draft one")), name: "plan.txt" }, { shape: "{ id version }" });
  await ada.command<Doc>("replaceContent", { id: doc.id, upload: await upload(text("draft two")) }, { shape: "{ id version }" });

  // the documents service's lines; each version's flow adds the catalogue's own when it ends
  const lines = await until("both document lines", async () => {
    const page = await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text } }" });
    const mine = page.items.filter((i) => i.source === "documents");
    return mine.length === 2 ? mine : undefined;
  });

  // newest first: the replace, then the one that added it
  expect(lines.map((i) => i.kind)).toEqual(["document.replaced", "document.added"]);
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
      return next?.items.some((i) => i.kind === "document.added") ? next : undefined;
    }, 8_000);
    // the catalogue's line for the same file lands when its flow ends, which may be in the same answer or a later one
    expect(all.items.filter((i) => i.source !== "catalogue").map((i) => `${i.source}:${i.kind}`)).toEqual([
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
  // the document's own line too, so nothing this test caused is still on its way when the next one starts
  await until("the document's own line", async () => (await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" })).items.find((i) => i.kind === "document.added"));
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
  await until("the document's own line", async () => (await workspace.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" })).items.find((i) => i.kind === "document.added"));
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
  // each instance puts every line it hears on its own streams once its write has been tried, whether it landed or
  // lost to the other's: a line on both streams is an event both instances are done with
  const ac = new AbortController();
  const heard = { primary: [] as Happened[], replica: [] as Happened[] };
  const listening = [follow(workspace, heard.primary, ac.signal), follow(replica, heard.replica, ac.signal)];

  try {
    // a stream answers nothing until something happens, so a line sent over the relay, which reaches every
    // instance and writes nothing, says both are open: sent until both have heard one
    await until("both streams to be open", async () => {
      await workspace.sql.query("select pg_notify('rayfold', $1)", [JSON.stringify({ from: "fleet-test", event: { name: "ActivityHappened", payload: { projectId: PROJECT, source: "test", kind: "sentinel", text: "", byId: null } } })]);
      return heard.primary.some((h) => h.kind === "sentinel") && heard.replica.some((h) => h.kind === "sentinel") ? true : undefined;
    });

    const ada = documents.client("ada");
    const doc = await ada.command<Doc>("createDocument", { projectId: PROJECT, upload: await upload(text("one copy")), name: "once.txt" }, { shape: "{ id version }" });
    await ada.command("moveDocument", { id: doc.id, folder: "contracts" }, { shape: "{ id }", ifVersion: doc.version });
    await ada.command("tagDocument", { id: doc.id, tags: ["legal"] }, { shape: "{ id }", ifVersion: doc.version + 1 });

    // both instances hear all three and both react; only one row each may exist, or the feed shows everything twice
    // for every replica anyone deploys
    const done = (h: Happened[]) => ["document.added", "document.filed", "document.tagged"].every((k) => h.some((x) => x.source === "documents" && x.kind === k));
    await until("both instances to have handled all three", () => (done(heard.primary) && done(heard.replica) ? true : undefined));
    const { rows } = await workspace.sql.query("select id from activity where source = 'documents' order by id");
    // a move and a tag are keyed on the moment the documents service made them, the same for every instance
    expect(rows.map((r) => r["id"])).toEqual([
      `documents:${doc.id}:1`,
      expect.stringMatching(new RegExp(`^documents:${doc.id}:filed:contracts:\\d+$`)),
      expect.stringMatching(new RegExp(`^documents:${doc.id}:tagged:legal:\\d+$`)),
    ]);

    // guard: the replica is not inert — it serves the same feed, which is why it was listening at all
    const fromReplica = await replica.client("ada").query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { source kind } }" });
    expect(fromReplica.items.filter((i) => i.source === "documents").map((i) => i.kind)).toEqual(["document.tagged", "document.filed", "document.added"]);
    // either instance may take the flow's last step: it is finished before the replica goes
    await settled();
  } finally {
    ac.abort();
    await Promise.all(listening);
    await replica.stop();
  }
});

interface Happened {
  source: string;
  kind: string;
}

/** Keeps every line an instance's activity stream carries; the abort that ends it is the expected ending. */
const follow = (svc: TestService, into: Happened[], abort: AbortSignal): Promise<void> =>
  (async () => {
    for await (const h of svc.client("ada").stream<Happened>("activityFeed", { projectId: PROJECT }, { signal: abort })) into.push(h);
  })().catch((e: unknown) => {
    if (!(e instanceof Error && e.name === "AbortError")) throw e;
  });
