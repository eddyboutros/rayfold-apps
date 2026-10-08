import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Mcp, mintAgentToken } from "../clients/agent/lib.mts";
import { startTestService, type TestService } from "./harness.ts";

/**
 * An agent on the workspace through the MCP bridge, with a token narrowed to a few operations: what it may do, what
 * a dry run does and does not, and what the token refuses, including widening itself.
 */
let svc: TestService;
const PROJECT = "p1";

beforeAll(async () => {
  svc = await startTestService("workspace");
});
afterAll(() => svc?.stop());
beforeEach(() => svc.reset());

const text = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

it("the bridge lists every command as a tool with a dry-run twin, and reads a query as a resource", async () => {
  const scoped = await mintAgentToken(svc.base, "ada", ["me", "issues", "createIssue", "addComment"]);
  expect(scoped.ops).toEqual(["me", "issues", "createIssue", "addComment"]);
  const mcp = new Mcp(svc.base, scoped.token);
  const { tools } = await mcp.tools();
  const names = tools.map((t) => t.name);
  // every operation, whatever the token names: the token is checked when a tool is used. a command that cannot run
  // dry (no @simulate in the schema) has no twin
  expect(names).toEqual([
    "projects", "project", "updateProject", "members", "me", "mintAgentToken", "workload", "issue", "issues", "comments", "activity",
    "createIssue", "createIssue.simulate", "updateIssue", "updateIssue.simulate", "assignIssue", "assignIssue.simulate", "moveIssue", "moveIssue.simulate",
    "attachDocument", "detachDocument", "addComment", "messages", "say", "notifications", "unread", "markRead",
  ]);
  expect(tools.find((t) => t.name === "createIssue")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  expect(tools.find((t) => t.name === "createIssue.simulate")?.annotations).toMatchObject({ readOnlyHint: true });
  // the manifest says the bridge is there
  expect(((await (await fetch(`${svc.base}/rayfold/manifest`)).json()) as { extensions: string[] }).extensions).toContain("mcp");

  const { resources } = await mcp.resources();
  expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(["rayfold://schema", "rayfold://query/me"]));
  const who = await mcp.read("rayfold://query/me");
  expect(JSON.parse(who.contents[0]?.text ?? "null")).toMatchObject({ id: "u1", name: "Ada Lovelace" });
});

it("a dry run answers with the result and writes nothing; the real call writes once, and a retry replays", async () => {
  const scoped = await mintAgentToken(svc.base, "ada", ["issues", "createIssue"]);
  const mcp = new Mcp(svc.base, scoped.token);
  const dry = await mcp.use("createIssue.simulate", { projectId: PROJECT, title: "Agent: check the mapping" });
  expect(dry.isError).toBeUndefined();
  expect((dry.structuredContent?.["result"] as { title: string }).title).toBe("Agent: check the mapping");
  const listed = async () => (await svc.client("ada").query<{ total: number }>("issues", { projectId: PROJECT }, { shape: "{ total }" })).total;
  expect(await listed()).toBe(0);

  const made = await mcp.use("createIssue", { projectId: PROJECT, title: "Agent: check the mapping" });
  expect(made.isError).toBeUndefined();
  expect(await listed()).toBe(1);
  // the same call again: the key is derived from the arguments, so the bridge replays rather than opening a second one
  const again = await mcp.use("createIssue", { projectId: PROJECT, title: "Agent: check the mapping" });
  expect((again.structuredContent?.["result"] as { id: string }).id).toBe((made.structuredContent?.["result"] as { id: string }).id);
  expect(await listed()).toBe(1);
  // and the feed credits the person, not a program: the token speaks for Ada
  const feed = await svc.client("grace").query<{ items: Array<{ kind: string; by: { name: string } | null }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind by { name } } }" });
  expect(feed.items).toMatchObject([{ kind: "issue.created", by: { name: "Ada Lovelace" } }]);
});

it("what the token does not name is refused, and the token cannot widen itself", async () => {
  const scoped = await mintAgentToken(svc.base, "ada", ["createIssue"]);
  const mcp = new Mcp(svc.base, scoped.token);
  const made = await mcp.use("createIssue", { projectId: PROJECT, title: "Agent: check the mapping" });
  const id = (made.structuredContent?.["result"] as { id: string }).id;

  const refused = await mcp.use("assignIssue", { id, assigneeId: "u2" });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("permission_denied");
  expect(await svc.client("ada").query<{ assignee: unknown }>("issue", { id }, { shape: "{ assignee { id } }" })).toMatchObject({ assignee: null });

  // widening: the policy on mintAgentToken reads viewer.agent, which this token sets
  const widen = await mcp.use("mintAgentToken", { ops: ["assignIssue"] });
  expect(widen.isError).toBe(true);
  expect(text(widen)).toContain("permission_denied");
  // guard: the person themselves may mint, and a token that names assignIssue may assign
  const wider = await mintAgentToken(svc.base, "ada", ["assignIssue"]);
  const assigned = await new Mcp(svc.base, wider.token).use("assignIssue", { id, assigneeId: "u2" });
  expect(assigned.isError).toBeUndefined();
  expect(await svc.client("ada").query<{ assignee: { id: string } }>("issue", { id }, { shape: "{ assignee { id } }" })).toMatchObject({ assignee: { id: "u2" } });
});

it("a token that names mintAgentToken still cannot mint: the command's own rule refuses an agent, whatever its list says", async () => {
  const before = Date.now();
  const scoped = await mintAgentToken(svc.base, "ada", ["mintAgentToken", "me"], 120_000);
  const after = Date.now();
  // the lifetime asked for, bounded by the clock either side of the call
  expect(Date.parse(scoped.expiresAt)).toBeGreaterThanOrEqual(before + 120_000);
  expect(Date.parse(scoped.expiresAt)).toBeLessThanOrEqual(after + 120_000);
  const widen = await new Mcp(svc.base, scoped.token).use("mintAgentToken", { ops: ["assignIssue"] });
  expect(widen.isError).toBe(true);
  expect(text(widen)).toContain("permission_denied");
  // guard: the same token may call the other operation it names
  expect(JSON.parse((await new Mcp(svc.base, scoped.token).read("rayfold://query/me")).contents[0]?.text ?? "null")).toMatchObject({ id: "u1" });
});

it("a JSON-RPC error from the bridge is thrown with the method it answered, and a page on a foreign origin is refused", async () => {
  const scoped = await mintAgentToken(svc.base, "ada", ["me"]);
  await expect(new Mcp(svc.base, scoped.token).call("no/such/method")).rejects.toThrow("no/such/method: ");
  const foreign = await fetch(`${svc.base}/rayfold/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: "keel_session=ada", origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "say", arguments: { projectId: PROJECT, body: "hi" } } }),
  });
  expect(foreign.status).toBe(403);
  expect((await svc.client("ada").query<{ total: number }>("messages", { projectId: PROJECT }, { shape: "{ total }" })).total).toBe(0);
  // guard: the fleet's own origin is allowed through the same door
  const own = await fetch(`${svc.base}/rayfold/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", cookie: "keel_session=ada", origin: "http://localhost:4200" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "say", arguments: { projectId: PROJECT, body: "hi" } } }),
  });
  expect(own.status).toBe(200);
  expect(((await own.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  expect((await svc.client("ada").query<{ total: number }>("messages", { projectId: PROJECT }, { shape: "{ total }" })).total).toBe(1);
});
