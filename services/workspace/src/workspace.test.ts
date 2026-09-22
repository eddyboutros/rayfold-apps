import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { signal, until } from "../../../e2e/wait.ts";

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

/*
 * Skipped until @rayfold/server 0.2.1: in 0.2.0 a live query keeps the batch's loader memo across its re-runs, so a
 * field loaded once (the assignee) is answered from the first run for as long as the query stays open. The runtime
 * fix and its own test are in the rayfold repository; this one turns on with the version bump.
 */
it.skip("an open issue list hears a hand-over made on another screen", async () => {
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
    const mine = await noor.query<{ items: Array<{ kind: string; readAt: number | null }>; total: number }>("notifications", {}, { shape: "{ items { kind text readAt } total }" });
    expect(mine.total).toBe(2);
    expect(mine.items.map((n) => n.kind)).toEqual(["comment.added", "issue.assigned"]);
    expect(mine.items.every((n) => n.readAt === null)).toBe(true);

    // reading them takes no key, by declaration (@idempotent(false)): done twice is done once by its nature
    const read = await noor.command<number>("markRead", { upTo: new Date().toISOString() }, {});
    expect(read).toBe(2);
    expect(await unread.wait("the badge to drop")).toBe(0);
    expect(await noor.command<number>("markRead", { upTo: new Date().toISOString() }, {})).toBe(0);
    // guard: a command that did not opt out still needs its key
    const unkeyed = await noor.command("say", { projectId: PROJECT, body: "hi" }, { shape: "{ id }", key: "short" }).then(() => null, (e: RayfoldClientError) => e);
    expect(unkeyed?.code).toBe("invalid_argument");

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
