import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { RayfoldClient, createFetchTransport, type RayfoldClientError } from "@rayfold/client";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { signal } from "../../../e2e/wait.ts";

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
