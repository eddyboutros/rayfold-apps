import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { RayfoldClientError } from "@rayfold/client";
import { startTestService, type TestService } from "../../../e2e/harness.ts";
import { signal } from "../../../e2e/wait.ts";

/**
 * The workspace service as it runs. Two promises a person relies on: a conversation they are looking at hears a
 * reply made elsewhere, and two people moving the same issue cannot both win.
 */
let svc: TestService;
const PROJECT = "p1";

beforeAll(async () => {
  svc = await startTestService("workspace", { DOCUMENTS_PROJECT: PROJECT });
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
    expect(next.items).toEqual([{ $type: "Comment", body: "Signed this morning", by: { $type: "Member", name: "Grace" } }]);
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
  await ada.command("addComment", { issueId: issue.id, body: "on it" }, { shape: "{ id }" });

  const feed = await ada.query<{ items: Array<{ kind: string; source: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind source } }" });
  expect(feed.items.map((i) => i.kind)).toEqual(["comment.added", "issue.moved", "issue.created"]);
  expect(feed.items.every((i) => i.source === "workspace")).toBe(true);
});
