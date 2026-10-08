import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { backends, listenersSince, liveClosed, startTestService, type TestService } from "../../../e2e/harness.ts";
import { signal, until } from "../../../e2e/wait.ts";
import { WorkspaceStore } from "./store.ts";

/**
 * The workspace service as it runs. Two promises a person relies on: a conversation they are looking at hears a
 * reply made elsewhere, and two people moving the same issue cannot both win.
 */
let svc: TestService;
const PROJECT = "p1";

beforeAll(async () => {
  svc = await startTestService("workspace");
});
afterAll(() => svc?.stop());
beforeEach(() => svc.reset());
// every live query a test opened is closed by its end, and a spy on the store goes with the test that set it
afterEach(async () => {
  vi.restoreAllMocks();
  await liveClosed(svc);
});

interface Issue {
  id: string;
  title: string;
  state: string;
  version: number;
}
interface Thread {
  items: Array<{ body: string; by: { name: string } }>;
}

it("an open thread hears a reply made from another screen", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id }" });

  // Ada is looking at the thread. it is empty, and it is live.
  const seen = signal<Thread>();
  const stop = ada.live<Thread>("comments", { issueId: issue.id }, { shape: "{ items { body by { name } } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the thread's first answer")).items).toEqual([]);

    // Grace replies from her own screen
    await svc.client("grace").command("addComment", { issueId: issue.id, body: "Signed this morning" }, { shape: "{ id }" });

    // the new comment is an entity Ada's thread never read, and it arrives anyway: the command's patch sets a
    // Comment, and a change to any entity of a type a live query returns re-runs it. that rule is what this pins.
    const next = await seen.wait("Ada's thread to hear Grace");
    expect(next.items).toEqual([{ $type: "Comment", body: "Signed this morning", by: { $type: "Member", name: "Grace Hopper" } }]);
  } finally {
    stop();
  }
});

it("a move on top of someone else's is refused, and says what the issue is now", async () => {
  const ada = svc.client("ada");
  const grace = svc.client("grace");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id version }" });

  // both read version 1; Grace moves first
  await grace.command<Issue>("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id state version }", ifVersion: issue.version });

  const refused = await ada
    .command<Issue>("moveIssue", { id: issue.id, to: "done" }, { shape: "{ id state version }", ifVersion: issue.version })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(refused).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  expect(refused?.data).toMatchObject({ expected: 1, actual: 2 });

  // nothing moved twice: Grace's move stands
  expect(await ada.query<Issue>("issue", { id: issue.id }, { shape: "{ state version }" })).toMatchObject({ state: "doing", version: 2 });

  // guard: with the version it actually has, the move goes through
  const done = await ada.command<Issue>("moveIssue", { id: issue.id, to: "done" }, { shape: "{ state version }", ifVersion: 2 });
  expect(done).toMatchObject({ state: "done", version: 3 });
});

it("a move that names no version is not refused, and the feed says who did what", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id }" });
  await ada.command("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id }" });
  await svc.client("grace").command("addComment", { issueId: issue.id, body: "on it" }, { shape: "{ id }" });

  const feed = await ada.query<Feed>("activity", { projectId: PROJECT }, { shape: "{ items { kind source by { name } } }" });
  expect(feed.items.map((i) => [i.kind, i.by?.name])).toEqual([
    ["comment.added", "Grace Hopper"],
    ["issue.moved", "Ada Lovelace"],
    ["issue.created", "Ada Lovelace"],
  ]);
  expect(feed.items.every((i) => i.source === "workspace")).toBe(true);
});

interface Feed {
  items: Array<{ kind: string; source: string; by: { name: string } | null }>;
}

it("an issue is handed to someone, and the feed says so", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id version assignee { name } }" });
  expect(issue).toMatchObject({ version: 1, assignee: null });

  const members = await ada.query<Array<{ id: string; name: string }>>("members", {}, { shape: "{ id name }" });
  expect(members.map((m) => m.name)).toEqual(["Ada Lovelace", "Grace Hopper", "Noor Haddad", "Tomás Ferreira"]);
  const noor = members.find((m) => m.name === "Noor Haddad")!;

  const handed = await ada.command<Issue & { assignee: { name: string } | null }>(
    "assignIssue",
    { id: issue.id, assigneeId: noor.id },
    { shape: "{ id version assignee { name } }", ifVersion: issue.version },
  );
  expect(handed).toMatchObject({ version: 2, assignee: { name: "Noor Haddad" } });

  // the version moved, so a hand-off on top of a stale read is refused like a move is
  const stale = await ada
    .command("assignIssue", { id: issue.id, assigneeId: null }, { shape: "{ id }", ifVersion: 1 })
    .then(() => null, (e: RayfoldClientError) => e);
  expect(stale).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });

  // guard: to nobody is a valid hand-off, with the version it has
  const dropped = await ada.command<Issue & { assignee: unknown }>("assignIssue", { id: issue.id, assigneeId: null }, { shape: "{ version assignee { name } }", ifVersion: 2 });
  expect(dropped).toMatchObject({ version: 3, assignee: null });

  const feed = await ada.query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind text by { name } } }" });
  expect(feed.items.map((i) => [i.kind, i.text])).toEqual([
    ["issue.assigned", "Sign the contract: nobody"],
    ["issue.assigned", "Sign the contract: Noor Haddad"],
    ["issue.created", "Sign the contract"],
  ]);
});

/** Runs a stream consumer; the abort that ends it at the end of a test is the expected ending, anything else is a failure. */
const listen = (consume: () => Promise<void>): Promise<void> =>
  consume().catch((e: unknown) => {
    if (!(e instanceof Error && e.name === "AbortError")) throw e;
  });

// a loaded field (the assignee) follows a hand-over under an open list: 0.2.0 kept the batch's loader memo across a
// live query's re-runs and answered it from the first run; 0.2.1 loads it again
it("an open issue list hears a hand-over made on another screen", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id version }" });
  const members = await ada.query<Array<{ id: string; name: string }>>("members", {}, { shape: "{ id name }" });
  const noor = members.find((m) => m.name === "Noor Haddad")!;

  const seen = signal<{ items: Array<{ id: string; assignee: { name: string } | null }> }>();
  const stop = svc.client("grace").live<{ items: Array<{ id: string; assignee: { name: string } | null }> }>("issues", { projectId: PROJECT }, { shape: "{ items { id assignee { name } } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the list's first answer")).items).toEqual([{ $type: "Issue", id: issue.id, assignee: null }]);
    await ada.command("assignIssue", { id: issue.id, assigneeId: noor.id }, { shape: "{ id }", ifVersion: issue.version });
    const next = await seen.wait("Grace's list to hear the hand-over");
    expect(next.items).toEqual([{ $type: "Issue", id: issue.id, assignee: { $type: "Member", name: "Noor Haddad" } }]);
  } finally {
    stop();
  }
});

it("a hand-over tells the person it went to, on a stream of their own, and a badge counts it until they read it", async () => {
  const ada = svc.client("ada");
  const noor = svc.client("noor");
  const members = await ada.query<Array<{ id: string; name: string }>>("members", {}, { shape: "{ id name }" });
  const noorId = members.find((m) => m.name === "Noor Haddad")!.id;

  // Noor's screen: a live badge, and the stream that carries each notification as it is written
  const unread = signal<number>();
  const stopBadge = noor.live<number>("unread", {}, {}, (n) => unread.fire(n), (e) => {
    throw e;
  });
  const ac = new AbortController();
  const heard: Array<{ kind: string; text: string }> = [];
  const listening = listen(async () => {
    for await (const n of noor.stream<{ kind: string; text: string }>("notified", {}, { signal: ac.signal })) heard.push(n);
  });
  // Ada's screen too: the stream is per person, so hers stays silent through all of it
  const adaHeard: unknown[] = [];
  const adaListening = listen(async () => {
    for await (const n of ada.stream("notified", {}, { signal: ac.signal })) adaHeard.push(n);
  });
  try {
    expect(await unread.wait("the badge's first answer")).toBe(0);

    const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Write the wave two comms" }, { shape: "{ id version }" });
    await ada.command("assignIssue", { id: issue.id, assigneeId: noorId }, { shape: "{ id }", ifVersion: issue.version });
    expect(await unread.wait("the badge to count the hand-over")).toBe(1);
    await until("the stream to carry it", async () => heard.length || undefined);
    expect(heard[0]).toMatchObject({ kind: "issue.assigned", text: "Ada Lovelace handed you Write the wave two comms" });

    // a reply on the issue Noor holds is hers to hear; her own reply is not
    await ada.command("addComment", { issueId: issue.id, body: "Draft is in the folder" }, { shape: "{ id }" });
    expect(await unread.wait("the badge to count the reply")).toBe(2);
    await noor.command("addComment", { issueId: issue.id, body: "Thanks" }, { shape: "{ id }" });
    // taking it herself tells nobody
    const held = await noor.query<Issue>("issue", { id: issue.id }, { shape: "{ version }" });
    await noor.command("assignIssue", { id: issue.id, assigneeId: noorId }, { shape: "{ id }", ifVersion: held.version });
    const mine = await noor.query<{ items: Array<{ kind: string; readAt: string | null }>; total: number }>("notifications", {}, { shape: "{ items { kind text readAt } total }" });
    expect(mine.total).toBe(2);
    expect(mine.items.map((n) => n.kind)).toEqual(["comment.added", "issue.assigned"]);
    expect(mine.items.every((n) => n.readAt === null)).toBe(true);

    // reading them takes no key, by declaration (@idempotent(false)): done twice is done once by its nature
    const read = await noor.command<number>("markRead", { upTo: new Date().toISOString() }, {});
    expect(read).toBe(2);
    expect(await unread.wait("the badge to drop")).toBe(0);
    expect(await noor.command<number>("markRead", { upTo: new Date().toISOString() }, {})).toBe(0);
    // guard: a command that did not opt out still needs its key. the client always sends one, so this is the batch
    // a program writing its own would send
    const raw = await fetch(`${svc.base}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer noor" },
      body: JSON.stringify({ ops: [{ id: 1, op: "say", args: { projectId: PROJECT, body: "hi" }, shape: "{ id }" }] }),
    });
    const frame = JSON.parse((await raw.text()).split("\n")[0]!) as { id: number; error?: { code: string } };
    expect(frame).toMatchObject({ id: 1, error: { code: "invalid_argument" } });
    // and one too short to be unique is no key either
    const short = await noor.command("say", { projectId: PROJECT, body: "hi" }, { shape: "{ id }", key: "short" }).then(() => null, (e: RayfoldClientError) => e);
    expect(short?.code).toBe("invalid_argument");
    expect((await noor.query<{ total: number }>("messages", { projectId: PROJECT }, { shape: "{ total }" })).total).toBe(0);

    // guard: Ada, who did the handing over, was told nothing, and cannot read Noor's
    expect((await ada.query<{ total: number }>("notifications", {}, { shape: "{ total }" })).total).toBe(0);
    expect(adaHeard).toEqual([]);
  } finally {
    stopBadge();
    ac.abort();
    await Promise.all([listening, adaListening]);
  }
});

it("a project's chat: what is said arrives on every open chat as it is said, and the history reads downwards", async () => {
  const ada = svc.client("ada");
  const grace = svc.client("grace");
  const ac = new AbortController();
  const heard: Array<{ body: string; byName: string }> = [];
  const listening = listen(async () => {
    for await (const said of grace.stream<{ body: string; byName: string }>("chat", { projectId: PROJECT }, { signal: ac.signal })) heard.push(said);
  });
  try {
    await ada.command("say", { projectId: PROJECT, body: "Is the mirror caught up?" }, { shape: "{ id }" });
    await until("Grace's chat to hear Ada", async () => heard.length || undefined);
    await grace.command("say", { projectId: PROJECT, body: "Four minutes behind, closing" }, { shape: "{ id }" });
    await until("Grace's chat to hear herself", async () => (heard.length === 2 ? true : undefined));
    expect(heard.map((s) => [s.byName, s.body])).toEqual([
      ["Ada Lovelace", "Is the mirror caught up?"],
      ["Grace Hopper", "Four minutes behind, closing"],
    ]);
    // another project's chat hears none of it
    await ada.command("say", { projectId: "p2", body: "elsewhere" }, { shape: "{ id }" });
    await ada.command("say", { projectId: PROJECT, body: "Good" }, { shape: "{ id }" });
    await until("the third line", async () => (heard.length === 3 ? true : undefined));
    expect(heard.map((s) => s.body)).not.toContain("elsewhere");

    const history = await ada.query<{ items: Array<{ body: string; by: { name: string } }>; total: number }>("messages", { projectId: PROJECT }, { shape: "{ items { body by { name } } total }" });
    expect(history.total).toBe(3);
    expect(history.items.map((m) => m.body)).toEqual(["Is the mirror caught up?", "Four minutes behind, closing", "Good"]);
    // an empty line is refused before any resolver runs
    const empty = await ada.command("say", { projectId: PROJECT, body: "" }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
    expect(empty?.code).toBe("invalid_argument");
  } finally {
    ac.abort();
    await listening;
  }
});

it("an issue's fields change one at a time: what a form did not touch is left alone, null clears, and a stale edit is refused", async () => {
  const ada = svc.client("ada");
  const grace = svc.client("grace");
  const SHAPE = "{ id version priority labels dueOn description title }";
  const issue = await ada.command<Detail>("createIssue", { projectId: PROJECT, title: "Rehearse the cutover", labels: ["Ops", " ops", "Wave-2"] }, { shape: SHAPE });
  // defaults, and labels tidied: trimmed, lower-cased, each once
  expect(issue).toMatchObject({ version: 1, priority: "normal", labels: ["ops", "wave-2"], dueOn: null, description: null });

  // Ada sets a priority and a day; Grace, reading the same version, writes a description. both land: the second
  // edit is on a different field, and it reads the version again after being told it moved
  const v2 = await ada.command<Detail>("updateIssue", { id: issue.id, changes: { priority: "high", dueOn: "2026-10-02" } }, { shape: SHAPE, ifVersion: 1 });
  expect(v2).toMatchObject({ version: 2, priority: "high", dueOn: "2026-10-02", labels: ["ops", "wave-2"], description: null });
  const stale = await grace.command("updateIssue", { id: issue.id, changes: { description: "Run it twice" } }, { shape: SHAPE, ifVersion: 1 }).then(() => null, (e: RayfoldClientError) => e);
  expect(stale).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  expect(stale?.data).toMatchObject({ expected: 1, actual: 2 });
  const v3 = await grace.command<Detail>("updateIssue", { id: issue.id, changes: { description: "Run it twice" } }, { shape: SHAPE, ifVersion: 2 });
  // what Ada set is still there: the description was the only column written
  expect(v3).toMatchObject({ version: 3, priority: "high", dueOn: "2026-10-02", description: "Run it twice" });

  // null clears a day; an absent field is not null
  const v4 = await ada.command<Detail>("updateIssue", { id: issue.id, changes: { dueOn: null } }, { shape: SHAPE, ifVersion: 3 });
  expect(v4).toMatchObject({ version: 4, dueOn: null, description: "Run it twice", priority: "high" });
  // read back, not the command's own answer: the columns it did not name are as they were
  expect(await ada.query<Detail>("issue", { id: issue.id }, { shape: SHAPE })).toMatchObject({ version: 4, dueOn: null, description: "Run it twice", priority: "high", labels: ["ops", "wave-2"] });
  // and a null where the schema allows none is refused before any resolver runs (guard for the rule above)
  const noTitle = await ada.command("updateIssue", { id: issue.id, changes: { title: null } }, { shape: SHAPE, ifVersion: 4 }).then(() => null, (e: RayfoldClientError) => e);
  expect(noTitle?.code).toBe("invalid_argument");

  // a dry run says what would happen and writes nothing
  const dry = await ada.command<Detail>("updateIssue", { id: issue.id, changes: { priority: "urgent" } }, { shape: SHAPE, ifVersion: 4, simulate: true });
  expect(dry).toMatchObject({ version: 5, priority: "urgent" });
  expect(await ada.query<Detail>("issue", { id: issue.id }, { shape: SHAPE })).toMatchObject({ version: 4, priority: "high" });

  const feed = await ada.query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind text } }" });
  expect(feed.items.map((i) => [i.kind, i.text])).toEqual([
    ["issue.edited", "Rehearse the cutover: due day cleared"],
    ["issue.edited", "Rehearse the cutover: description"],
    ["issue.edited", "Rehearse the cutover: priority high, due 2026-10-02"],
    ["issue.created", "Rehearse the cutover"],
  ]);
});

interface Detail {
  id: string;
  version: number;
  title: string;
  priority: string;
  labels: string[];
  dueOn: string | null;
  description: string | null;
}

it("the list narrows by state, holder and label, and the workload counts what each person holds", async () => {
  const ada = svc.client("ada");
  const members = await ada.query<Array<{ id: string; name: string; title: string | null; email: string | null }>>("members", {}, { shape: "{ id name title email }" });
  expect(members[0]).toEqual({ $type: "Member", id: "u1", name: "Ada Lovelace", title: "Engineering lead", email: "ada@keel.example" });
  const noor = members.find((m) => m.name === "Noor Haddad")!;

  const a = await ada.command<Detail>("createIssue", { projectId: PROJECT, title: "A", assigneeId: noor.id, labels: ["ops"], dueOn: "2000-01-01" }, { shape: "{ id version }" });
  const b = await ada.command<Detail>("createIssue", { projectId: PROJECT, title: "B", assigneeId: noor.id, labels: ["legal"] }, { shape: "{ id version }" });
  await ada.command<Detail>("createIssue", { projectId: PROJECT, title: "C", labels: ["ops", "legal"] }, { shape: "{ id }" });
  await ada.command("moveIssue", { id: b.id, to: "doing" }, { shape: "{ id }", ifVersion: b.version });

  const titles = async (args: Record<string, unknown>) => (await ada.query<{ items: Array<{ title: string }>; total: number }>("issues", { projectId: PROJECT, ...args }, { shape: "{ items { title } total }" })).items.map((i) => i.title);
  expect((await titles({})).sort()).toEqual(["A", "B", "C"]);
  expect((await titles({ label: "ops" })).sort()).toEqual(["A", "C"]);
  expect((await titles({ assigneeId: noor.id })).sort()).toEqual(["A", "B"]);
  expect(await titles({ state: "doing" })).toEqual(["B"]);
  expect((await titles({ assigneeId: noor.id, label: "legal" })).sort()).toEqual(["B"]);
  // guard: a label nobody used narrows to nothing rather than to everything
  expect(await titles({ label: "nope" })).toEqual([]);

  const load = await ada.query<Array<{ member: { name: string }; open: number; doing: number; done: number; overdue: number }>>("workload", {}, { shape: "{ member { name } open doing done overdue }" });
  expect(load.map((w) => [w.member.name, w.open, w.doing, w.done, w.overdue])).toEqual([
    ["Ada Lovelace", 0, 0, 0, 0],
    ["Grace Hopper", 0, 0, 0, 0],
    ["Noor Haddad", 1, 1, 0, 1],
    ["Tomás Ferreira", 0, 0, 0, 0],
  ]);
  // done is never overdue, whatever its day
  await ada.command("moveIssue", { id: a.id, to: "doing" }, { shape: "{ id }", ifVersion: a.version });
  await ada.command("moveIssue", { id: a.id, to: "done" }, { shape: "{ id }", ifVersion: a.version + 1 });
  const after = await ada.query<Array<{ member: { name: string }; done: number; overdue: number }>>("workload", {}, { shape: "{ member { name } done overdue }" });
  expect(after.find((w) => w.member.name === "Noor Haddad")).toMatchObject({ done: 1, overdue: 0 });
});

it("three commands in one batch: the second and third name the first's result with $ref before it exists", async () => {
  const ada = svc.client("ada");
  const me = await ada.query<{ id: string; name: string }>("me", {}, { shape: "{ id name }" });
  expect(me).toMatchObject({ id: "u1", name: "Ada Lovelace" });

  const batch = ada.batch();
  const opened = batch.command<{ id: string; title: string; version: number }>("createIssue", { projectId: PROJECT, title: "Wire the sandbox" }, { shape: "{ id title version }" });
  const handed = batch.command<{ id: string; version: number; assignee: { name: string } | null }>("assignIssue", { id: opened.ref("id"), assigneeId: me.id }, { shape: "{ id version assignee { name } }" });
  const noted = batch.command<{ id: string; issueId: string }>("addComment", { issueId: opened.ref("id"), body: "Opened from the command palette." }, { shape: "{ id issueId }" });
  await batch.run();

  const issue = await opened.promise;
  expect(await handed.promise).toMatchObject({ id: issue.id, version: 2, assignee: { name: "Ada Lovelace" } });
  expect((await noted.promise).issueId).toBe(issue.id);
  // one request did all three, in order: the feed has the three lines, and the issue is as the last of them left it
  const feed = await ada.query<{ items: Array<{ kind: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" });
  expect(feed.items.map((i) => i.kind)).toEqual(["comment.added", "issue.assigned", "issue.created"]);
  // guard: a reference into a failed op fails the ops that named it, and nothing after the failure lands
  const bad = ada.batch();
  const missing = bad.command("assignIssue", { id: "nope", assigneeId: me.id }, { shape: "{ id }" });
  const after = bad.command("addComment", { issueId: missing.ref("id"), body: "never" }, { shape: "{ id }" });
  await bad.run();
  expect(await missing.promise.then(() => null, (e: RayfoldClientError) => e.type)).toBe("NotFound");
  expect(await after.promise.then(() => "landed", (e: RayfoldClientError) => e)).toMatchObject({ code: "failed_precondition", type: "DependencyFailed" });
  expect((await ada.query<{ items: unknown[] }>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" })).items).toHaveLength(3);
});

it("a sign-off asked in the approvals service, on the JVM, is a feed line and a notification here: the relay's format is the contract", async () => {
  const grace = svc.client("grace");
  const unread = signal<number>();
  const stop = grace.live<number>("unread", {}, {}, (n) => unread.fire(n), (e) => {
    throw e;
  });
  try {
    expect(await unread.wait("the badge's first answer")).toBe(0);
    // what the Kotlin service's PgRelay sends: one NOTIFY on the shared channel, in the shape both runtimes read.
    // sent here by hand, so this suite proves the workspace's half without a JVM in the room
    const send = (event: string, payload: Record<string, unknown>) =>
      svc.sql.query("select pg_notify('rayfold', $1)", [JSON.stringify({ from: "approvals-test", event: { name: event, payload } })]);
    await send("ApprovalRequested", { approvalId: "ap1", documentId: "d1", projectId: PROJECT, documentName: "MSA v3.pdf", requesterId: "u1", approverId: "u2" });
    expect(await unread.wait("Grace to be told she was asked")).toBe(1);
    const told = await grace.query<{ items: Array<{ kind: string; text: string }> }>("notifications", {}, { shape: "{ items { kind text } }" });
    expect(told.items[0]).toMatchObject({ kind: "approval.requested", text: "Ada Lovelace asked you to sign off on MSA v3.pdf" });

    await send("ApprovalDecided", { approvalId: "ap1", documentId: "d1", projectId: PROJECT, documentName: "MSA v3.pdf", decision: "approved", byId: "u2", note: "Clause 3 is fine." });
    const feed = await until("both lines on the feed", async () => {
      const page = await grace.query<{ items: Array<{ source: string; kind: string; text: string; by: { name: string } | null }> }>("activity", { projectId: PROJECT }, { shape: "{ items { source kind text by { name } } }" });
      return page.items.length === 2 ? page : undefined;
    });
    expect(feed.items.map((i) => [i.source, i.kind, i.by?.name, i.text.replace(" (d1)", "")])).toEqual([
      ["approvals", "approval.decided", "Grace Hopper", "MSA v3.pdf: approved, Clause 3 is fine."],
      ["approvals", "approval.requested", "Ada Lovelace", "MSA v3.pdf: Grace Hopper"],
    ]);
    // the one who asked hears the answer; the same event heard again (a second instance) writes nothing more
    const ada = await until("Ada to be told", async () => {
      const page = await svc.client("ada").query<{ items: Array<{ kind: string; text: string }> }>("notifications", {}, { shape: "{ items { kind text } }" });
      return page.items.length ? page : undefined;
    });
    expect(ada.items[0]).toMatchObject({ kind: "approval.decided", text: "Grace Hopper approved MSA v3.pdf: Clause 3 is fine." });
    await send("ApprovalDecided", { approvalId: "ap1", documentId: "d1", projectId: PROJECT, documentName: "MSA v3.pdf", decision: "approved", byId: "u2", note: "Clause 3 is fine." });
    await send("ApprovalRequested", { approvalId: "ap2", documentId: "d1", projectId: PROJECT, documentName: "MSA v3.pdf", requesterId: "u1", approverId: "u2" });
    expect(await unread.wait("the badge to count the second request only")).toBe(2);
    expect((await grace.query<{ items: unknown[] }>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" })).items).toHaveLength(3);
  } finally {
    stop();
  }
});

it("a browser's session cookie is the same person as a bearer token", async () => {
  // what a browser sends: the cookie the shell set at sign-in, and no Authorization header at all
  const browser = new RayfoldClient({
    transport: createFetchTransport({ url: `${svc.base}/rayfold`, headers: () => ({ cookie: "keel_session=grace" }) }),
  });
  const issue = await browser.command<Issue>("createIssue", { projectId: PROJECT, title: "Renew the certificate" }, { shape: "{ id }" });
  await browser.command("addComment", { issueId: issue.id, body: "expires Friday" }, { shape: "{ id }" });

  const thread = await svc.client("ada").query<Thread>("comments", { issueId: issue.id }, { shape: "{ items { body by { name } } }" });
  expect(thread.items).toEqual([{ $type: "Comment", body: "expires Friday", by: { $type: "Member", name: "Grace Hopper" } }]);

  // guard: a session for someone who is not on the team is nobody, and nobody may not write
  const stranger = new RayfoldClient({
    transport: createFetchTransport({ url: `${svc.base}/rayfold`, headers: () => ({ cookie: "keel_session=mallory" }) }),
  });
  const refused = await stranger.command("createIssue", { projectId: PROJECT, title: "Let me in" }, { shape: "{ id }" }).then(() => null, (e: RayfoldClientError) => e);
  expect(refused?.code).toBe("unauthenticated");
});

/** How many times this instance has re-run an open live query on `op`, from its own stats. */
async function rerunsOf(op: string): Promise<number> {
  const stats = (await (await fetch(`${svc.base}/rayfold/stats`, { headers: { authorization: `Bearer ${svc.opsToken}` } })).json()) as { counters: Array<{ name: string; labels: Record<string, string>; count: number }> };
  return stats.counters.filter((c) => c.name === "rayfold.live.reran" && c.labels["op"] === op).reduce((n, c) => n + c.count, 0);
}

it("a document pinned to an issue is on every open list of issues, follows a rename made in the documents service, and comes off again", async () => {
  const ada = svc.client("ada");
  const grace = svc.client("grace");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id }" });
  const other = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Renew the lease" }, { shape: "{ id }" });

  // Grace has the list open; the pins are loaded with the page, not per issue
  type Pin = { id: string; documentId: string; name: string; url: string };
  const seen = signal<{ items: Array<{ id: string; attachments: Pin[] }> }>();
  const stop = grace.live<{ items: Array<{ id: string; attachments: Pin[] }> }>("issues", { projectId: PROJECT }, { shape: "{ items { id attachments { id documentId name url } } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the list's first answer")).items.map((i) => i.attachments)).toEqual([[], []]);

    const pinned = await ada.command<Pin>("attachDocument", { issueId: issue.id, documentId: "d1", name: "MSA v3.pdf", url: "/files/d1/r1" }, { shape: "{ id documentId name url by { name } }" });
    expect(pinned).toMatchObject({ documentId: "d1", name: "MSA v3.pdf", url: "/files/d1/r1", by: { name: "Ada Lovelace" } });
    // the same pair again is the same pin, not a second row
    const again = await ada.command<Pin>("attachDocument", { issueId: issue.id, documentId: "d1", name: "MSA v3.pdf", url: "/files/d1/r1" }, { shape: "{ id }" });
    expect(again.id).toBe(pinned.id);
    // the other issue is left alone
    const withPin = await seen.wait("Grace's list to show the pin");
    expect(Object.fromEntries(withPin.items.map((i) => [i.id, i.attachments.map((p) => p.name)]))).toEqual({ [issue.id]: ["MSA v3.pdf"], [other.id]: [] });

    // the documents service keeps a new version under a new name: the event reaches here over the relay, as it does
    // for the feed, and the pin follows without this service asking the other
    await svc.sql.query("select pg_notify('rayfold', $1)", [
      JSON.stringify({ from: "documents-test", event: { name: "DocumentChanged", payload: { documentId: "d1", projectId: PROJECT, name: "MSA v4.pdf", version: 2, byId: "u1" } } }),
    ]);
    const renamed = await seen.wait("the pin to follow the rename");
    expect(renamed.items.find((i) => i.id === issue.id)?.attachments).toEqual([{ $type: "Attachment", id: pinned.id, documentId: "d1", name: "MSA v4.pdf", url: "/files/d1/r1" }]);
    // guard: a rename of a document nobody pinned wakes nothing. a re-run whose answer did not change sends no
    // frame, so what is counted is the server's re-runs of the list: its feed line says the event was handled, and
    // the detach below is the one re-run there should be
    const reruns = await rerunsOf("issues");
    await svc.sql.query("select pg_notify('rayfold', $1)", [
      JSON.stringify({ from: "documents-test", event: { name: "DocumentChanged", payload: { documentId: "d9", projectId: PROJECT, name: "Nothing.pdf", version: 2, byId: "u1" } } }),
    ]);
    await until("the unpinned rename to reach the feed", async () =>
      (await ada.query<{ items: Array<{ text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { text } }" })).items.find((l) => l.text === "Nothing.pdf, now version 2 (d9)"),
    );

    const gone = await ada.command<Pin | null>("detachDocument", { id: pinned.id }, { shape: "{ id name }" });
    expect(gone).toMatchObject({ id: pinned.id, name: "MSA v4.pdf" });
    expect((await seen.wait("the list's next answer, the detach's")).items.map((i) => i.attachments)).toEqual([[], []]);
    expect((await rerunsOf("issues")) - reruns).toBe(1);
    // detaching what is not there is null, not an error
    expect(await ada.command<Pin | null>("detachDocument", { id: pinned.id }, { shape: "{ id }" })).toBeNull();
    // and the feed says what happened, once each: the second pin of the same pair wrote no line
    const feed = await ada.query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind text } }" });
    expect(feed.items.filter((l) => l.kind.startsWith("document.")).map((l) => `${l.kind} ${l.text}`)).toEqual([
      "document.detached Sign the contract: MSA v4.pdf",
      "document.replaced Nothing.pdf, now version 2 (d9)",
      "document.replaced MSA v4.pdf, now version 2 (d1)",
      "document.attached Sign the contract: MSA v3.pdf",
    ]);
  } finally {
    stop();
  }
  // an issue that does not exist cannot take a pin
  await expect(ada.command("attachDocument", { issueId: "nope", documentId: "d1", name: "x", url: "/x" })).rejects.toMatchObject({ type: "NotFound" });
});

it("a project's settings are the team's: an edit needs the version it read, reaches an open list, and its default assignee takes new issues", async () => {
  const ada = svc.client("ada");
  const grace = svc.client("grace");
  type P = { id: string; name: string; color: string; version: number; defaultAssignee: { name: string } | null };
  const shape = "{ id name color version defaultAssignee { name } }";

  // the two the fleet always had, in order, and nobody takes their issues yet
  const seen = signal<P[]>();
  const stop = grace.live<P[]>("projects", {}, { shape }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    const first = await seen.wait("the list's first answer");
    expect(first.map((p) => [p.id, p.name, p.color, p.defaultAssignee])).toEqual([
      ["p1", "Northwind rollout", "indigo", null],
      ["p2", "Q3 compliance", "amber", null],
    ]);
    // guard: an issue opened now stays with nobody
    expect(await ada.command("createIssue", { projectId: "p1", title: "Before" }, { shape: "{ assignee { name } }" })).toMatchObject({ assignee: null });

    const p1 = first[0]!;
    const changed = await ada.command<P>("updateProject", { id: "p1", changes: { name: "Northwind cutover", color: "teal", defaultAssigneeId: "u2" } }, { shape, ifVersion: p1.version });
    expect(changed).toMatchObject({ name: "Northwind cutover", color: "teal", version: p1.version + 1, defaultAssignee: { name: "Grace Hopper" } });
    expect((await seen.wait("Grace's list to hear the edit"))[0]).toMatchObject({ name: "Northwind cutover", color: "teal" });

    // the same version again is someone else's edit landing on this one: refused
    await expect(grace.command("updateProject", { id: "p1", changes: { name: "Mine" } }, { ifVersion: p1.version })).rejects.toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
    // a name cannot be emptied, and nobody who is not on the team can take the issues
    await expect(ada.command("updateProject", { id: "p1", changes: { name: " " } })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(ada.command("updateProject", { id: "p1", changes: { defaultAssigneeId: "u99" } })).rejects.toMatchObject({ code: "invalid_argument" });

    // what the setting does: an issue that names nobody goes to Grace; one that names Noor, or null on purpose, does not
    expect(await ada.command("createIssue", { projectId: "p1", title: "After" }, { shape: "{ assignee { name } }" })).toMatchObject({ assignee: { name: "Grace Hopper" } });
    expect(await ada.command("createIssue", { projectId: "p1", title: "For Noor", assigneeId: "u3" }, { shape: "{ assignee { name } }" })).toMatchObject({ assignee: { name: "Noor Haddad" } });
    expect(await ada.command("createIssue", { projectId: "p1", title: "Unowned", assigneeId: null }, { shape: "{ assignee { name } }" })).toMatchObject({ assignee: null });
    // guard: the other project has no default, so its issues stay with nobody
    expect(await ada.command("createIssue", { projectId: "p2", title: "Elsewhere" }, { shape: "{ assignee { name } }" })).toMatchObject({ assignee: null });

    // the edit is on the feed, and the rail's REST route answers the same list without a Rayfold client
    const feed = await ada.query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: "p1" }, { shape: "{ items { kind text } }" });
    expect(feed.items.find((l) => l.kind === "project.edited")?.text).toBe("Northwind cutover: renamed, colour teal, default assignee");
    const rest = await fetch(`${svc.base}/projects`, { headers: { authorization: "Bearer grace" } });
    expect(rest.status).toBe(200);
    expect(((await rest.json()) as Array<{ id: string; name: string; color: string }>).map((p) => [p.id, p.name, p.color])).toEqual([
      ["p1", "Northwind cutover", "teal"],
      ["p2", "Q3 compliance", "amber"],
    ]);
    // guard: nobody signed in gets nothing from it
    expect((await fetch(`${svc.base}/projects`)).status).toBe(401);
  } finally {
    stop();
  }
});

it("a move is one line on the feed however often it is heard, and moving back into the same folder later is a second", async () => {
  const ada = svc.client("ada");
  const filed = (folder: string, at: string) =>
    svc.sql.query("select pg_notify('rayfold', $1)", [
      JSON.stringify({ from: "documents-test", event: { name: "DocumentFiled", payload: { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", folder, byId: "u1", at } } }),
    ]);
  const lines = async () =>
    (await ada.query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind text } }", policy: "network" })).items
      .filter((l) => l.kind === "document.filed")
      .map((l) => l.text.replace(" (d1)", ""));

  // the same event twice, as two instances of the documents service would each relay it, then the same folder later
  await filed("legal", "2026-10-01T09:00:00.000Z");
  await filed("legal", "2026-10-01T09:00:00.000Z");
  await filed("legal", "2026-10-01T09:05:00.000Z");
  // a move elsewhere, last: once its line is written the three before it have been handled, in the order heard
  await filed("archive", "2026-10-01T09:10:00.000Z");
  await until("the last move on the feed", async () => ((await lines()).includes("MSA.pdf: archive") ? true : undefined));
  expect((await lines()).sort()).toEqual(["MSA.pdf: archive", "MSA.pdf: legal", "MSA.pdf: legal"]);
});

/** RFC 3339 in UTC with milliseconds: what `Date.prototype.toISOString` writes, and what the schema's Instant is. */
const RFC3339_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

it("sends every Instant as RFC 3339 in UTC, orders and compares by the instant, and reads one with an offset", async () => {
  await svc.sql.query("update projects set updated_at = 1767225600000 where id = 'p1'");
  await svc.sql.query("insert into issues (id, project_id, title, state, version, updated_at) values ('iA', 'p1', 'Planted', 'open', 1, 999999999999)");
  await svc.sql.query("insert into comments (id, issue_id, body, at, by_id) values ('cA', 'iA', 'planted', 1767225600000, 'u2')");
  await svc.sql.query("insert into attachments (id, issue_id, document_id, name, url, at, by_id) values ('pA', 'iA', 'd1', 'MSA.pdf', '/files/r1', 1767225600000, 'u1')");
  await svc.sql.query("insert into messages (id, project_id, body, at, by_id) values ('mA', 'p1', 'planted', 1767225600000, 'u1')");
  // either side of the moment epoch milliseconds gained a digit: the numbers' own text sorts these the wrong way round
  await svc.sql.query(
    "insert into activity (id, project_id, source, kind, text, at, by_id) values ('aOld', 'p1', 'workspace', 'x', 'older', 999999999999, 'u1'), ('aNew', 'p1', 'workspace', 'x', 'newer', 1000000000000, 'u1')",
  );
  // one at midnight UTC on the first of January, one a millisecond after
  await svc.sql.query(
    "insert into notifications (id, recipient_id, kind, text, project_id, at) values ('nOn', 'u3', 'x', 'on the instant', 'p1', 1767225600000), ('nAfter', 'u3', 'x', 'a millisecond later', 'p1', 1767225600001)",
  );
  const ada = svc.client("ada");
  const noor = svc.client("noor");

  expect((await ada.query<{ updatedAt: string }>("project", { id: "p1" }, { shape: "{ updatedAt }" })).updatedAt).toBe("2026-01-01T00:00:00.000Z");
  const issue = await ada.query<{ updatedAt: string; attachments: Array<{ at: string }> }>("issue", { id: "iA" }, { shape: "{ updatedAt attachments { at } }" });
  expect(issue.updatedAt).toBe("2001-09-09T01:46:39.999Z");
  expect(issue.attachments.map((p) => p.at)).toEqual(["2026-01-01T00:00:00.000Z"]);
  expect((await ada.query<{ items: Array<{ at: string }> }>("comments", { issueId: "iA" }, { shape: "{ items { at } }" })).items.map((c) => c.at)).toEqual(["2026-01-01T00:00:00.000Z"]);
  expect((await ada.query<{ items: Array<{ at: string }> }>("messages", { projectId: "p1" }, { shape: "{ items { at } }" })).items.map((m) => m.at)).toEqual(["2026-01-01T00:00:00.000Z"]);

  const feed = await ada.query<{ items: Array<{ text: string; at: string }> }>("activity", { projectId: "p1" }, { shape: "{ items { text at } }" });
  expect(feed.items.map((l) => [l.text, l.at])).toEqual([
    ["newer", "2001-09-09T01:46:40.000Z"],
    ["older", "2001-09-09T01:46:39.999Z"],
  ]);
  // guard: newest first as instants, which the numbers written out as text would have got backwards
  expect(Date.parse(feed.items[0]!.at)).toBeGreaterThan(Date.parse(feed.items[1]!.at));
  expect(String(1000000000000) < String(999999999999)).toBe(true);

  // the same midnight written with an offset: compared as text it is after both, compared as an instant it is the first
  // one exactly, so exactly one is read
  expect("2026-01-01T00:00:00.001Z" < "2026-01-01T01:00:00+01:00").toBe(true);
  expect(await noor.command<number>("markRead", { upTo: "2026-01-01T01:00:00+01:00" }, {})).toBe(1);
  const mine = await noor.query<{ items: Array<{ id: string; at: string; readAt: string | null }> }>("notifications", {}, { shape: "{ items { id at readAt } }" });
  expect(mine.items.map((n) => [n.id, n.at])).toEqual([
    ["nAfter", "2026-01-01T00:00:00.001Z"],
    ["nOn", "2026-01-01T00:00:00.000Z"],
  ]);
  expect(mine.items[0]!.readAt).toBeNull();
  const { rows: readRows } = await svc.sql.query("select read_at from notifications where id = 'nOn'");
  expect(mine.items[1]!.readAt).toBe(new Date(Number(readRows[0]!["read_at"])).toISOString());

  // what a command answers is the same form, naming the instant the column keeps; and so is the event the chat carries
  const listener = await svc.sql.connect();
  const heard = signal<{ at: unknown }>();
  listener.on("notification", (n) => {
    const event = (JSON.parse(n.payload ?? "{}") as { event?: { name: string; payload: { at: unknown } } }).event;
    if (event?.name === "Said") heard.fire(event.payload);
  });
  try {
    await listener.query("listen rayfold");
    const said = await ada.command<{ id: string; at: string }>("say", { projectId: "p1", body: "on the wire" }, { shape: "{ id at }" });
    const { rows } = await svc.sql.query("select at from messages where id = $1", [said.id]);
    expect(said.at).toMatch(RFC3339_UTC);
    expect(said.at).toBe(new Date(Number(rows[0]!["at"])).toISOString());
    expect((await heard.wait("Said on the relay")).at).toBe(said.at);
  } finally {
    await listener.query("unlisten rayfold");
    listener.release();
  }
  const moved = await ada.command<{ updatedAt: string }>("moveIssue", { id: "iA", to: "doing" }, { shape: "{ updatedAt }", ifVersion: 1 });
  const { rows: issueRows } = await svc.sql.query("select updated_at from issues where id = 'iA'");
  expect(moved.updatedAt).toBe(new Date(Number(issueRows[0]!["updated_at"])).toISOString());
  expect((await ada.command<{ expiresAt: string }>("mintAgentToken", { ops: ["me"], ttlMs: 60_000 }, { shape: "{ expiresAt }" })).expiresAt).toMatch(RFC3339_UTC);
});

type Paged = { items: Array<{ id: string }>; total: number; hasMore: boolean; cursor: string | null };
/** Every page of a list, by its own cursor, until it says there are no more. */
async function walk(client: RayfoldClient, op: string, args: Record<string, unknown>, first: number): Promise<{ pages: string[][]; totals: number[]; more: boolean[] }> {
  const pages: string[][] = [];
  const totals: number[] = [];
  const more: boolean[] = [];
  let after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const page: Paged = await client.query<Paged>(op, { ...args, page: { first, ...(after ? { after } : {}) } }, { shape: "{ items { id } total hasMore cursor }" });
    pages.push(page.items.map((x) => x.id));
    totals.push(page.total);
    more.push(page.hasMore);
    if (!page.hasMore) return { pages, totals, more };
    after = page.cursor;
  }
  throw new Error(`${op} never said it was done`);
}

it("every list pages by its cursor to the end: each row once, in order, ties in one millisecond included, and hasMore false on the last page", async () => {
  // planted, so the order is known: ids that sort against time, and a burst of lines in one millisecond
  await svc.sql.query("insert into issues (id, project_id, title, state, version, updated_at) values ('iP1','p1','one','open',1,1),('iP2','p1','two','open',1,1),('iP3','p1','three','open',1,1),('iP4','p1','four','open',1,1),('iP5','p1','five','open',1,1)");
  await svc.sql.query("insert into comments (id, issue_id, body, at, by_id) values ('c3','iP1','first',1000,'u1'),('c2','iP1','second',2000,'u2'),('c1','iP1','third',3000,'u1')");
  await svc.sql.query("insert into activity (id, project_id, source, kind, text, at, by_id) values ('a0','p1','workspace','x','older',4000,'u1'),('a1','p1','workspace','x','tie',5000,'u1'),('a2','p1','workspace','x','tie',5000,'u1'),('a3','p1','workspace','x','tie',5000,'u1')");
  await svc.sql.query("insert into messages (id, project_id, body, at, by_id) values ('m1','p1','one',1000,'u1'),('m2','p1','two',2000,'u2'),('m3','p1','three',3000,'u1')");
  await svc.sql.query("insert into notifications (id, recipient_id, kind, text, project_id, at) values ('n1','u3','x','one','p1',1000),('n2','u3','x','two','p1',2000),('n3','u3','x','three','p1',3000)");
  const ada = svc.client("ada");

  expect(await walk(ada, "issues", { projectId: PROJECT }, 2)).toEqual({ pages: [["iP1", "iP2"], ["iP3", "iP4"], ["iP5"]], totals: [5, 5, 5], more: [true, true, false] });
  // oldest first, by time and not by id
  expect(await walk(ada, "comments", { issueId: "iP1" }, 2)).toEqual({ pages: [["c3", "c2"], ["c1"]], totals: [3, 3], more: [true, false] });
  // newest first; three lines in the same millisecond are all there, across the page break
  expect(await walk(ada, "activity", { projectId: PROJECT }, 2)).toEqual({ pages: [["a3", "a2"], ["a1", "a0"]], totals: [4, 4], more: [true, false] });
  // a chat reads downwards and pages backwards: the newest two first, then what came before them
  expect(await walk(ada, "messages", { projectId: PROJECT }, 2)).toEqual({ pages: [["m2", "m3"], ["m1"]], totals: [3, 3], more: [true, false] });
  expect(await walk(svc.client("noor"), "notifications", {}, 2)).toEqual({ pages: [["n3", "n2"], ["n1"]], totals: [3, 3], more: [true, false] });
  // the thread inside an issue is the same list
  const lazy = await ada.query<{ comments: Paged }>("issue", { id: "iP1" }, { shape: "{ comments(page: { first: 2 }) { items { id } total hasMore cursor } }" });
  expect(lazy.comments).toMatchObject({ items: [{ id: "c3" }, { id: "c2" }], total: 3, hasMore: true });
  // guard: a page that holds everything says so
  expect(await walk(ada, "comments", { issueId: "iP1" }, 3)).toEqual({ pages: [["c3", "c2", "c1"]], totals: [3], more: [false] });
});

/** What a relayed event looks like on the shared channel: what the documents and approvals services send. */
const relay = (event: string, payload: Record<string, unknown>) =>
  svc.sql.query("select pg_notify('rayfold', $1)", [JSON.stringify({ from: "workspace-test", event: { name: event, payload } })]);

const feedOf = async (projectId = PROJECT) =>
  (await svc.client("ada").query<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId }, { shape: "{ items { kind text } }", policy: "network" })).items.map((l) => `${l.kind} ${l.text}`);

it("a new name on the same bytes is a rename on the feed; new bytes, or a publisher that does not say, a new version", async () => {
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", version: 1, byId: "u1", revision: true });
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA final.pdf", version: 2, byId: "u1", revision: false });
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA final.pdf", version: 3, byId: "u2", revision: true });
  // guard: an event from before the field: a later version, as it always was
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA final.pdf", version: 4, byId: "u2" });
  await until("the four lines", async () => ((await feedOf()).length === 4 ? true : undefined));
  expect(await feedOf()).toEqual([
    "document.replaced MSA final.pdf, now version 4 (d1)",
    "document.replaced MSA final.pdf, now version 3 (d1)",
    "document.renamed MSA final.pdf (d1)",
    "document.added MSA.pdf (d1)",
  ]);
  // a first version is added, whatever the flag says
  await relay("DocumentChanged", { documentId: "d2", projectId: PROJECT, name: "SOW.pdf", version: 1, byId: "u1", revision: false });
  await until("the added line", async () => ((await feedOf())[0] === "document.added SOW.pdf (d2)" ? true : undefined));
});

it("the feed says what each edit changed, and an edit is tidied the way a new issue is", async () => {
  const ada = svc.client("ada");
  const SHAPE = "{ id version title labels description }";
  const issue = await ada.command<Detail>("createIssue", { projectId: PROJECT, title: "Draft", labels: ["ops"], description: "first" }, { shape: SHAPE });
  const v2 = await ada.command<Detail>("updateIssue", { id: issue.id, changes: { title: "Draft two", labels: [" Legal", "legal", "Q4 "] } }, { shape: SHAPE, ifVersion: 1 });
  expect(v2).toMatchObject({ title: "Draft two", labels: ["legal", "q4"], description: "first" });
  await ada.command("updateIssue", { id: issue.id, changes: { labels: [], description: "   " } }, { shape: SHAPE, ifVersion: 2 });
  expect(await ada.query("issue", { id: issue.id }, { shape: SHAPE })).toEqual({ $type: "Issue", id: issue.id, version: 3, title: "Draft two", labels: [], description: null });
  expect(await feedOf()).toEqual([
    "issue.edited Draft two: description cleared, labels cleared",
    "issue.edited Draft two: renamed, labels legal q4",
    "issue.created Draft",
  ]);
});

it("a project's description is trimmed and a blank one is none; its colour cannot be emptied; what is not sent stays", async () => {
  const ada = svc.client("ada");
  const shape = "{ name description color version }";
  const p1 = await ada.query<{ version: number; description: string }>("project", { id: "p1" }, { shape });
  const named = await ada.command("updateProject", { id: "p1", changes: { name: "  Northwind  " } }, { shape, ifVersion: p1.version });
  // the description nobody sent is the seed's, still
  expect(named).toEqual({ $type: "Project", name: "Northwind", description: p1.description, color: "indigo", version: p1.version + 1 });
  expect(await ada.query("project", { id: "p1" }, { shape })).toEqual(named);
  expect(await ada.command("updateProject", { id: "p1", changes: { description: "  Three waves.  " } }, { shape })).toMatchObject({ description: "Three waves." });
  expect(await ada.command("updateProject", { id: "p1", changes: { description: "   " } }, { shape })).toMatchObject({ description: null, color: "indigo" });
  await expect(ada.command("updateProject", { id: "p1", changes: { color: null } })).rejects.toMatchObject({ code: "invalid_argument", message: "updateProject().changes.color: cannot be null" });
  expect(await ada.query("project", { id: "p1" }, { shape })).toEqual({ $type: "Project", name: "Northwind", description: null, color: "indigo", version: p1.version + 3 });
});

it("a line heard over the relay wakes an open feed on its own, with no platform, and each kind reads as itself", async () => {
  const seen = signal<{ items: Array<{ kind: string; text: string }> }>();
  const stop = svc.client("grace").live<{ items: Array<{ kind: string; text: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind text } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    expect((await seen.wait("the feed's first answer")).items).toEqual([]);
    await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", version: 1, byId: "u1" });
    expect((await seen.wait("the open feed to hear the relayed line")).items.map((l) => l.text)).toEqual(["MSA.pdf (d1)"]);
    // tags taken off are a line too, and two remarks on one document are two lines
    await relay("DocumentTagged", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", tags: [], byId: "u1", at: "2026-10-01T09:00:00.000Z" });
    await relay("DocumentNoted", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", excerpt: "first", byId: "u2" });
    await relay("DocumentNoted", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", excerpt: "second", byId: "u2" });
    await until("the four lines", async () => ((await feedOf()).length === 4 ? true : undefined));
    expect((await feedOf()).sort()).toEqual(["document.added MSA.pdf (d1)", "document.noted MSA.pdf: first (d1)", "document.noted MSA.pdf: second (d1)", "document.tagged MSA.pdf: no tags (d1)"]);
  } finally {
    stop();
  }
});

it("a decision tells the one who asked, unless it was a withdrawal or their own; a decision with no note says only the decision", async () => {
  const ada = svc.client("ada");
  const ac = new AbortController();
  const heard: Array<{ kind: string; text: string }> = [];
  const listening = listen(async () => {
    for await (const n of ada.stream<{ kind: string; text: string }>("notified", {}, { signal: ac.signal })) heard.push(n);
  });
  try {
    // a stream answers nothing until something happens: Ada is asked something herself, and hears it, before anything counts
    await until("Ada's stream to be open", async () => {
      await relay("ApprovalRequested", { approvalId: "open", documentId: "d0", projectId: PROJECT, documentName: "Open.pdf", requesterId: "u2", approverId: "u1" });
      return heard.length ? true : undefined;
    });
    // a withdrawal is recorded as by the approver here, so that only the withdrawal rule, not the self rule, keeps it quiet
    for (const [id, decision, byId] of [["w", "withdrawn", "u2"], ["self", "approved", "u1"], ["d", "declined", "u2"]] as const) {
      await relay("ApprovalRequested", { approvalId: id, documentId: "d1", projectId: PROJECT, documentName: `${id}.pdf`, requesterId: "u1", approverId: byId });
      await until(`the request for ${id} on the feed`, async () => ((await feedOf()).some((l) => l.startsWith(`approval.requested ${id}.pdf`)) ? true : undefined));
      await relay("ApprovalDecided", { approvalId: id, documentId: "d1", projectId: PROJECT, documentName: `${id}.pdf`, decision, byId, note: null });
    }
    // the same decision heard again, as a second instance of the approvals service would relay it
    await relay("ApprovalDecided", { approvalId: "d", documentId: "d1", projectId: PROJECT, documentName: "d.pdf", decision: "declined", byId: "u2", note: null });
    await until("the declined line on the feed", async () => ((await feedOf()).includes("approval.decided d.pdf: declined (d1)") ? true : undefined));
    await until("Ada to hear the decline", () => (heard.some((n) => n.kind === "approval.decided") ? true : undefined));
    // the sentinel last: once it is heard, everything relayed before it has been handled
    await relay("ApprovalRequested", { approvalId: "last", documentId: "d0", projectId: PROJECT, documentName: "Last.pdf", requesterId: "u2", approverId: "u1" });
    await until("the last request", () => (heard.some((n) => n.text.endsWith("Last.pdf")) ? true : undefined));
    const mine = await ada.query<{ items: Array<{ kind: string; text: string }> }>("notifications", { page: { first: 30 } }, { shape: "{ items { kind text } }" });
    expect(mine.items.map((n) => `${n.kind} ${n.text}`).sort()).toEqual(
      [
        "approval.decided Grace Hopper declined d.pdf",
        "approval.requested Ada Lovelace asked you to sign off on self.pdf",
        "approval.requested Grace Hopper asked you to sign off on Last.pdf",
        "approval.requested Grace Hopper asked you to sign off on Open.pdf",
      ].sort(),
    );
    // each notification reached her screen once, however often its cause was heard
    expect(heard.filter((n) => n.kind === "approval.decided").map((n) => n.text)).toEqual(["Grace Hopper declined d.pdf"]);
  } finally {
    ac.abort();
    await listening;
  }
});

it("a store that fails while a sign-off is heard is logged, and the service carries on: nothing is left to reject unheard", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void errors.push(String(line)));
  vi.spyOn(WorkspaceStore.prototype, "approvalRequesterOf").mockRejectedValue(new Error("the database went away"));
  vi.spyOn(WorkspaceStore.prototype, "notify").mockRejectedValueOnce(new Error("the database went away"));
  await relay("ApprovalRequested", { approvalId: "f1", documentId: "d1", projectId: PROJECT, documentName: "F.pdf", requesterId: "u1", approverId: "u2" });
  await relay("ApprovalDecided", { approvalId: "f1", documentId: "d1", projectId: PROJECT, documentName: "F.pdf", decision: "approved", byId: "u2", note: null });
  await until("both failures to be logged", () => (errors.length >= 2 ? true : undefined));
  expect(errors.sort()).toEqual([
    '[workspace] could not tell a requester {"approvalId":"f1","error":"the database went away"}',
    '[workspace] could not tell an approver {"approvalId":"f1","error":"the database went away"}',
  ]);
  // guard: the feed lines were written all the same, and the service still answers
  await until("both lines", async () => ((await feedOf()).length === 2 ? true : undefined));
});

it("a project's stream carries only that project's lines", async () => {
  const ac = new AbortController();
  const heard: Array<{ projectId: string; text: string }> = [];
  const listening = listen(async () => {
    for await (const h of svc.client("grace").stream<{ projectId: string; text: string }>("activityFeed", { projectId: PROJECT }, { signal: ac.signal })) heard.push(h);
  });
  try {
    await until("the stream to be open", async () => {
      await relay("ActivityHappened", { projectId: PROJECT, source: "test", kind: "sentinel", text: "open", byId: null });
      return heard.length ? true : undefined;
    });
    await svc.client("ada").command("createIssue", { projectId: "p2", title: "Elsewhere" }, { shape: "{ id }" });
    await svc.client("ada").command("createIssue", { projectId: PROJECT, title: "Here" }, { shape: "{ id }" });
    await until("the second line", () => (heard.some((h) => h.text === "Here") ? true : undefined));
    expect(heard.filter((h) => h.text !== "open").map((h) => [h.projectId, h.text])).toEqual([[PROJECT, "Here"]]);
  } finally {
    ac.abort();
    await listening;
  }
});

it("a list's loaded fields belong to their own rows: each issue's holder, and each issue's pins oldest first", async () => {
  const ada = svc.client("ada");
  const a = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "A", assigneeId: "u3" }, { shape: "{ id }" });
  await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "B", assigneeId: "u2" }, { shape: "{ id }" });
  await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "C" }, { shape: "{ id }" });
  await svc.sql.query("insert into attachments (id, issue_id, document_id, name, url, at, by_id) values ('pZ', $1, 'd1', 'old.pdf', '/files/1', 1000, 'u1'), ('pA', $1, 'd2', 'new.pdf', '/files/2', 2000, 'u2')", [a.id]);
  const list = await ada.query<{ items: Array<{ title: string; assignee: { name: string } | null; attachments: Array<{ name: string; by: { name: string } }> }> }>("issues", { projectId: PROJECT }, { shape: "{ items { title assignee { name } attachments { name by { name } } } }" });
  expect(list.items.map((i) => [i.title, i.assignee?.name ?? null, i.attachments.map((p) => `${p.name} by ${p.by.name}`)]).sort()).toEqual([
    ["A", "Noor Haddad", ["old.pdf by Ada Lovelace", "new.pdf by Grace Hopper"]],
    ["B", "Grace Hopper", []],
    ["C", null, []],
  ]);
});

it("an issue due today is not overdue yet, one due yesterday is, and the open count is the open ones only", async () => {
  const ada = svc.client("ada");
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const today = day(0);
  await ada.command("createIssue", { projectId: PROJECT, title: "Today", assigneeId: "u3", dueOn: today }, { shape: "{ id }" });
  await ada.command("createIssue", { projectId: PROJECT, title: "Yesterday", assigneeId: "u3", dueOn: day(-1) }, { shape: "{ id }" });
  const done = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Done", assigneeId: "u3" }, { shape: "{ id version }" });
  await ada.command("moveIssue", { id: done.id, to: "done" }, { shape: "{ id }", ifVersion: done.version });
  const noor = (await ada.query<Array<{ member: { id: string }; open: number; doing: number; done: number; overdue: number }>>("workload", {}, { shape: "{ member { id } open doing done overdue }" })).find((w) => w.member.id === "u3");
  // the day turned while this ran: what "today" means moved under the test, and the answer is not this test's to judge
  if (day(0) !== today) return;
  expect(noor).toEqual({ member: { $type: "Member", id: "u3" }, open: 2, doing: 0, done: 1, overdue: 1 });
});

it("an open workload follows a hand-over, and a move is an event on the relay with where it came from", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Hand me over" }, { shape: "{ id version }" });
  const seen = signal<Array<{ member: { id: string }; open: number }>>();
  const stop = svc.client("grace").live<Array<{ member: { id: string }; open: number }>>("workload", {}, { shape: "{ member { id } open }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  const listener = await svc.sql.connect();
  const moved = signal<unknown>();
  listener.on("notification", (n) => {
    const event = (JSON.parse(n.payload ?? "{}") as { event?: { name: string; payload: unknown } }).event;
    if (event?.name === "IssueMoved") moved.fire(event.payload);
  });
  try {
    await listener.query("listen rayfold");
    expect((await seen.wait("the workload's first answer")).find((w) => w.member.id === "u2")?.open).toBe(0);
    await ada.command("assignIssue", { id: issue.id, assigneeId: "u2" }, { shape: "{ id }", ifVersion: issue.version });
    expect((await seen.wait("the workload to follow the hand-over")).find((w) => w.member.id === "u2")?.open).toBe(1);
    await ada.command("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id }", ifVersion: issue.version + 1 });
    expect(await moved.wait("IssueMoved on the relay")).toEqual({ issueId: issue.id, from: "open", to: "doing" });
  } finally {
    stop();
    await listener.query("unlisten rayfold");
    listener.release();
  }
});

it("a document heard again under the name its pins already have wakes no list", async () => {
  const ada = svc.client("ada");
  const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: "Sign the contract" }, { shape: "{ id }" });
  await ada.command("attachDocument", { issueId: issue.id, documentId: "d1", name: "MSA.pdf", url: "/files/r1" }, { shape: "{ id }" });
  const seen = signal<unknown>();
  const stop = svc.client("grace").live("issues", { projectId: PROJECT }, { shape: "{ items { id attachments { name } } }" }, (d) => seen.fire(d), (e) => {
    throw e;
  });
  try {
    await seen.wait("the list's first answer");
    const before = await rerunsOf("issues");
    await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA.pdf", version: 2, byId: "u1" });
    await until("the event to be handled", async () => ((await feedOf()).includes("document.replaced MSA.pdf, now version 2 (d1)") ? true : undefined));
    expect((await rerunsOf("issues")) - before).toBe(0);
    // guard: a new name does wake it
    await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "MSA v2.pdf", version: 3, byId: "u1" });
    await seen.wait("the list to hear the rename");
    expect((await rerunsOf("issues")) - before).toBe(1);
  } finally {
    stop();
  }
});

it("who a request is from: a bearer before a cookie, and no other scheme at all", async () => {
  const as = (headers: Record<string, string>) => new RayfoldClient({ transport: createFetchTransport({ url: `${svc.base}/rayfold`, headers: () => headers }) });
  expect(await as({ authorization: "Bearer ada", cookie: "keel_session=grace" }).query("me", {}, { shape: "{ id }" })).toEqual({ $type: "Member", id: "u1" });
  // a scheme as long as "Bearer " is not a bearer
  await expect(as({ authorization: "Digest ada" }).query("me", {}, { shape: "{ id }" })).rejects.toMatchObject({ code: "unauthenticated" });
  // guard: the cookie alone is the person it names, among the browser's other cookies
  expect(await as({ cookie: "theme=dark; keel_session=grace" }).query("me", {}, { shape: "{ id }" })).toEqual({ $type: "Member", id: "u2" });
});

it("a page on a foreign origin cannot write as a signed-in person; the fleet's own origin can", async () => {
  const from = (origin: string) =>
    fetch(`${svc.base}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "keel_session=grace", origin },
      body: JSON.stringify({ ops: [{ id: 1, op: "say", args: { projectId: PROJECT, body: "hi" }, shape: "{ id }", key: crypto.randomUUID() }] }),
    });
  const foreign = await from("https://evil.example");
  expect(foreign.status).toBe(403);
  expect(await foreign.json()).toMatchObject({ status: 403, code: "permission_denied" });
  expect((await svc.client("ada").query<{ total: number }>("messages", { projectId: PROJECT }, { shape: "{ total }" })).total).toBe(0);
  const own = await from("http://localhost:4200");
  expect(own.status).toBe(200);
  const frame = JSON.parse((await own.text()).split("\n")[0]!) as { id: number; ok: { $type: string; id: string } };
  expect(frame).toMatchObject({ id: 1, ok: { $type: "Message" }, fin: true });
  expect((await svc.client("ada").query<{ items: Array<{ id: string }> }>("messages", { projectId: PROJECT }, { shape: "{ items { id } }" })).items).toEqual([{ $type: "Message", id: frame.ok.id }]);
});

it("a batch over the default cost budget is refused before it runs", async () => {
  const batch = svc.client("ada").batch();
  const ops = Array.from({ length: 12 }, () => batch.query("issues", { projectId: PROJECT, page: { first: 100 } }, { shape: "{ items { id } }" }));
  await batch.run();
  const refused = await ops[0]!.promise.then(() => null, (e: RayfoldClientError) => e);
  expect(refused).toMatchObject({ code: "resource_exhausted", data: { budget: 1000 } });
  // guard: one such page is within it
  expect(await svc.client("ada").query("issues", { projectId: PROJECT, page: { first: 100 } }, { shape: "{ total }" })).toEqual({ total: 0 });
});

it("an instance starts with the team's roster as it is now, answers no stats without an ops token, reports a database it cannot reach, and gives back its connections when it stops", async () => {
  const held: number[] = [];
  await svc.sql.query("update members set name = 'Ada L.', title = null where id = 'u1'");
  const before = await backends(svc.sql);
  const other = await startTestService("workspace", { OPS_TOKEN: "" }, 9);
  try {
    // its relay's connection, its own and nobody else's
    const relays = await listenersSince(svc.sql, before);
    expect(relays).toHaveLength(1);
    held.push(...relays);
    expect(await svc.client("ada").query("me", {}, { shape: "{ name title }" })).toEqual({ $type: "Member", name: "Ada Lovelace", title: "Engineering lead" });
    // no token configured: the route is not there, even for a request that sends the empty one
    expect((await fetch(`${other.base}/rayfold/stats`, { headers: { authorization: "Bearer " } })).status).toBe(404);
    expect((await fetch(`${other.base}/rayfold/ready`)).status).toBe(200);
    // readiness asks the database: a pool that cannot answer is an instance that is not ready
    const pool = other.service.deps.sql;
    const query = pool.query.bind(pool);
    pool.query = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof pool.query;
    try {
      expect((await fetch(`${other.base}/rayfold/ready`)).status).toBe(503);
    } finally {
      pool.query = query;
    }
    expect((await fetch(`${other.base}/rayfold/ready`)).status).toBe(200);
  } finally {
    await other.stop();
  }
  // ended, not merely quiet: a relay that let go but kept its connection is still a connection
  await until("its relay connection to be gone", async () => ((await backends(svc.sql)).has(held[0]!) ? undefined : true));
});

/** Each line on the project's feed by its kind, as the query answers it: subject, detail and the joined text apart. */
type Told = { subject: string; detail: string | null; text: string };
const toldOf = async (projectId = PROJECT): Promise<Record<string, Told>> => {
  const page = await svc.client("ada").query<{ items: Array<Told & { kind: string }> }>("activity", { projectId }, { shape: "{ items { kind subject detail text } }", policy: "network" });
  return Object.fromEntries(page.items.map(({ kind, subject, detail, text }) => [kind, { subject, detail, text }]));
};

it("every line a command writes keeps a title's own colon in its subject, and its detail apart: on the query and on the stream", async () => {
  const ada = svc.client("ada");
  const TITLE = "Q3: audit pack";
  const ac = new AbortController();
  const heard: Array<{ kind: string; subject: string | null; detail: string | null; text: string }> = [];
  const listening = listen(async () => {
    for await (const h of svc.client("grace").stream<(typeof heard)[number]>("activityFeed", { projectId: PROJECT }, { signal: ac.signal })) heard.push(h);
  });
  try {
    await until("the stream to be open", async () => {
      await relay("ActivityHappened", { projectId: PROJECT, source: "test", kind: "sentinel", text: "open", byId: null });
      return heard.length ? true : undefined;
    });
    const issue = await ada.command<Issue>("createIssue", { projectId: PROJECT, title: TITLE }, { shape: "{ id version }" });
    await ada.command("updateIssue", { id: issue.id, changes: { priority: "high" } }, { shape: "{ id }", ifVersion: 1 });
    await ada.command("assignIssue", { id: issue.id, assigneeId: "u3" }, { shape: "{ id }", ifVersion: 2 });
    await ada.command("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id }", ifVersion: 3 });
    const pin = await ada.command<{ id: string }>("attachDocument", { issueId: issue.id, documentId: "d1", name: "brief: v2.txt", url: "/files/d1" }, { shape: "{ id }" });
    await ada.command("detachDocument", { id: pin.id }, { shape: "{ id }" });
    await ada.command("addComment", { issueId: issue.id, body: "On it: noon works" }, { shape: "{ id }" });
    const p1 = await ada.query<{ version: number }>("project", { id: PROJECT }, { shape: "{ version }" });
    await ada.command("updateProject", { id: PROJECT, changes: { name: "Q3: Northwind" } }, { shape: "{ id }", ifVersion: p1.version });

    expect(await toldOf()).toEqual({
      "issue.created": { subject: TITLE, detail: null, text: TITLE },
      "issue.edited": { subject: TITLE, detail: "priority high", text: `${TITLE}: priority high` },
      "issue.assigned": { subject: TITLE, detail: "Noor Haddad", text: `${TITLE}: Noor Haddad` },
      "issue.moved": { subject: TITLE, detail: "open → doing", text: `${TITLE}: open → doing` },
      "document.attached": { subject: TITLE, detail: "brief: v2.txt", text: `${TITLE}: brief: v2.txt` },
      "document.detached": { subject: TITLE, detail: "brief: v2.txt", text: `${TITLE}: brief: v2.txt` },
      "comment.added": { subject: TITLE, detail: "On it: noon works", text: `${TITLE}: On it: noon works` },
      "project.edited": { subject: "Q3: Northwind", detail: "renamed", text: "Q3: Northwind: renamed" },
    });
    // the stream carries the same two fields, so a screen that hears a line never splits one either
    await until("the last line on the stream", () => (heard.some((h) => h.kind === "project.edited") ? true : undefined));
    expect(heard.filter((h) => h.kind !== "sentinel").map((h) => [h.kind, h.subject, h.detail])).toEqual([
      ["issue.created", TITLE, null],
      ["issue.edited", TITLE, "priority high"],
      ["issue.assigned", TITLE, "Noor Haddad"],
      ["issue.moved", TITLE, "open → doing"],
      ["document.attached", TITLE, "brief: v2.txt"],
      ["document.detached", TITLE, "brief: v2.txt"],
      ["comment.added", TITLE, "On it: noon works"],
      ["project.edited", "Q3: Northwind", "renamed"],
    ]);
  } finally {
    ac.abort();
    await listening;
  }
});

it("every line heard over the relay keeps a name's own colon in its subject, its detail apart, and the id only in the text", async () => {
  const NAME = "Q3: MSA.pdf";
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: NAME, version: 1, byId: "u1", revision: true });
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: NAME, version: 2, byId: "u1", revision: true });
  await relay("DocumentChanged", { documentId: "d1", projectId: PROJECT, name: "Q3: MSA final.pdf", version: 3, byId: "u1", revision: false });
  await relay("DocumentFiled", { documentId: "d1", projectId: PROJECT, name: NAME, folder: "legal: 2026", byId: "u1", at: "2026-10-01T09:00:00.000Z" });
  await relay("DocumentTagged", { documentId: "d1", projectId: PROJECT, name: NAME, tags: ["q3:legal", "msa"], byId: "u1", at: "2026-10-01T09:00:00.000Z" });
  await relay("DocumentNoted", { documentId: "d1", projectId: PROJECT, name: NAME, excerpt: "Looks right: ship it", byId: "u2" });
  await relay("ApprovalRequested", { approvalId: "ap1", documentId: "d1", projectId: PROJECT, documentName: NAME, requesterId: "u1", approverId: "u2" });
  await relay("ApprovalDecided", { approvalId: "ap1", documentId: "d1", projectId: PROJECT, documentName: NAME, decision: "approved", byId: "u2", note: "clause 3: fine" });
  await until("the eight lines", async () => (Object.keys(await toldOf()).length === 8 ? true : undefined));
  expect(await toldOf()).toEqual({
    "document.added": { subject: NAME, detail: null, text: `${NAME} (d1)` },
    "document.replaced": { subject: NAME, detail: "now version 2", text: `${NAME}, now version 2 (d1)` },
    "document.renamed": { subject: "Q3: MSA final.pdf", detail: null, text: "Q3: MSA final.pdf (d1)" },
    "document.filed": { subject: NAME, detail: "legal: 2026", text: `${NAME}: legal: 2026 (d1)` },
    "document.tagged": { subject: NAME, detail: "q3:legal msa", text: `${NAME}: q3:legal msa (d1)` },
    "document.noted": { subject: NAME, detail: "Looks right: ship it", text: `${NAME}: Looks right: ship it (d1)` },
    "approval.requested": { subject: NAME, detail: "Grace Hopper", text: `${NAME}: Grace Hopper (d1)` },
    "approval.decided": { subject: NAME, detail: "approved, clause 3: fine", text: `${NAME}: approved, clause 3: fine (d1)` },
  });
});

it("lines written before subject and detail had columns: read whole meanwhile, then split where the text is unambiguous and kept whole where it is not", async () => {
  // what the table held before: a text and nothing else, which is what the two added columns leave on an old row
  const old: Array<[string, string, string, string]> = [
    ["o01", "workspace", "issue.created", "Q3: audit pack"],
    ["o02", "workspace", "issue.moved", "Q3: audit pack: open → doing"],
    ["o03", "workspace", "issue.assigned", "Book the venue: Grace Hopper"],
    ["o04", "workspace", "issue.assigned", "Q3: audit pack: Grace Hopper"],
    ["o05", "workspace", "comment.added", "Book the venue: On it"],
    ["o06", "workspace", "comment.added", "Q3: audit pack: On it"],
    ["o07", "workspace", "issue.created", "Ends (in brackets)"],
    ["o08", "workspace", "project.edited", "Northwind: renamed"],
    ["o09", "documents", "document.added", "Q3: MSA.pdf (d1)"],
    ["o10", "documents", "document.replaced", "Q3: MSA.pdf, now version 2 (0f9e8d7c-6b5a-4321-9876-543210fedcba)"],
    ["o11", "documents", "document.filed", "MSA.pdf: legal (d1)"],
    ["o12", "approvals", "approval.decided", "Q3: MSA.pdf: approved (d1)"],
    ["o13", "catalogue", "document.indexed", "plan.pdf (d2)"],
  ];
  for (const [i, [id, source, kind, text]] of old.entries()) {
    await svc.sql.query("insert into activity (id, project_id, source, kind, text, at, by_id) values ($1, 'p1', $2, $3, $4, $5, 'u1')", [id, source, kind, text, 1000 + i]);
  }
  // a line written since, already apart, which the backfill must leave exactly as it is
  await svc.sql.query("insert into activity (id, project_id, source, kind, text, subject, detail, at, by_id) values ('n01', 'p1', 'workspace', 'comment.added', 'A: b: c', 'A: b', 'c', 5000, 'u1')");
  const read = async () =>
    (await svc.client("ada").query<{ items: Array<{ id: string; subject: string; detail: string | null; text: string }> }>("activity", { projectId: PROJECT, page: { first: 50 } }, { shape: "{ items { id subject detail text } }", policy: "network" })).items
      .map((l) => [l.id, l.subject, l.detail, l.text])
      .sort();

  // before the next start fills them in (an older instance still writing, mid-rollout): the whole text, no detail
  expect(await read()).toEqual([...old.map(([id, , , text]) => [id, text, null, text]), ["n01", "A: b", "c", "A: b: c"]].sort());

  await new WorkspaceStore(svc.sql).migrate();
  const split: Array<[string, string, string | null]> = [
    ["o01", "Q3: audit pack", null],
    ["o02", "Q3: audit pack", "open → doing"],
    ["o03", "Book the venue", "Grace Hopper"],
    // two colons and nothing to say which is the title's: kept whole rather than split in the wrong place
    ["o04", "Q3: audit pack: Grace Hopper", null],
    ["o05", "Book the venue", "On it"],
    ["o06", "Q3: audit pack: On it", null],
    // a workspace line has no id on the end: brackets in a title are the title's
    ["o07", "Ends (in brackets)", null],
    ["o08", "Northwind", "renamed"],
    ["o09", "Q3: MSA.pdf", null],
    ["o10", "Q3: MSA.pdf", "now version 2"],
    ["o11", "MSA.pdf", "legal"],
    ["o12", "Q3: MSA.pdf: approved", null],
    ["o13", "plan.pdf", null],
  ];
  const expected = [...split.map(([id, subject, detail]) => [id, subject, detail, old.find((o) => o[0] === id)?.[3]]), ["n01", "A: b", "c", "A: b: c"]].sort();
  expect(await read()).toEqual(expected);
  // a second start finds nothing left to fill in and changes nothing
  await new WorkspaceStore(svc.sql).migrate();
  expect(await read()).toEqual(expected);
  expect((await svc.sql.query("select count(*)::int as n from activity where subject is null")).rows[0].n).toBe(0);
});
