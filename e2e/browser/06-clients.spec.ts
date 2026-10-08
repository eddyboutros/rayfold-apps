import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADA, BASE, MODE, closeStore, feedLines, signIn, stored } from "./fleet.ts";

/**
 * The two programs that are not a browser, run as a person runs them (`npm run agent`, `npm run field`) against the
 * running fleet, and what they did, seen in the browser and in the workspace's tables.
 */
test.afterAll(closeStore);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The workspace as a program reaches it: its own port in development, the gateway's path behind one. */
const WORKSPACE = MODE === "dev" ? "http://localhost:4002" : `${BASE}/api/workspace`;

/** A client run to its end, its output a line each with the indentation it prints taken off. */
function client(script: string): { code: number | null; lines: string[]; out: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", join(root, "clients", script)], {
    cwd: root,
    env: { ...process.env, WORKSPACE_URL: WORKSPACE, WHO: "ada", PROJECT: "p1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = `${run.stdout}${run.stderr}`;
  return { code: run.status, out, lines: out.split("\n").map((l) => l.trim()).filter(Boolean) };
}

const issues = (page: Page) => page.locator("section.slot", { has: page.locator("h2", { hasText: "Issues" }) });

test("the agent, on a token Ada minted for four operations, dry-runs, creates an issue and a comment, and is refused the rest", async ({ page }) => {
  const TITLE = "Agent: check the EDI mapping";
  const count = async () => ((await stored<{ n: number }>("select count(*)::int as n from issues where title = $1", [TITLE]))[0] as { n: number }).n;
  const before = await count();
  const run = client("agent/agent.mts");
  expect(run.code, run.out).toBe(0);
  expect(run.lines).toContain("1. ada mints a token for the agent: four operations, fifteen minutes");
  expect(run.lines.find((l) => l.startsWith("ops "))).toMatch(/^ops me, issues, createIssue, addComment; expires .+$/);
  // every command a tool with a .simulate twin, every query a tool: what the bridge lists for the workspace schema
  expect(run.lines.find((l) => / tools, among them: /.test(l))).toBe("27 tools, among them: projects, project, updateProject, members, me, mintAgentToken, workload, issue…");
  expect(run.lines).toContain('{"$type":"Member","id":"u1","name":"Ada Lovelace","title":"Engineering lead","email":"ada@keel.example"}');
  const created = run.lines.find((l) => l.startsWith("created "))!.slice("created ".length);
  expect(created).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(run.lines.filter((l) => l.startsWith("isError "))).toEqual([
    "isError true: permission_denied: This capability does not allow assignIssue()",
    "isError true: permission_denied: This capability does not allow mintAgentToken()",
  ]);

  // the dry run wrote nothing and the real one an issue, the one the agent was told of, with its note, Ada's
  expect(await count()).toBe(before + 1);
  expect(await stored("select project_id, state, assignee_id from issues where id = $1", [created])).toEqual([{ project_id: "p1", state: "open", assignee_id: null }]);
  expect(await stored("select body, by_id from comments where issue_id = $1", [created])).toEqual([{ body: "Opened by an agent over MCP, with a scoped token.", by_id: "u1" }]);

  // in the browser, as Ada: one more of them on her list, and on the feed under her name
  await signIn(page, ADA);
  await expect(issues(page).locator("li", { has: page.locator("button.title .text", { hasText: TITLE }) })).toHaveCount(before + 1);
  // the newest line opening it is this run's, Ada's
  await expect.poll(async () => (await feedLines(page, TITLE)).find((l) => l.includes(" | opened | "))).toBe(`Ada Lovelace | opened | ${TITLE}`);
});

test("a comment on an issue whose title has a colon is told with the whole title", async ({ page }) => {
  // the line keeps its subject and its detail apart, so a title's own colon is never taken for the one between them
  const TITLE = "Agent: check the EDI mapping";
  const run = client("agent/agent.mts");
  expect(run.code, run.out).toBe(0);
  await signIn(page, ADA);
  await expect.poll(async () => (await feedLines(page, TITLE))[0], { timeout: 5_000 }).toBe(`Ada Lovelace | commented on | ${TITLE} | “Opened by an agent over MCP, with a scoped token.”`);
});

test("the field client works offline over Rayfold Binary: the move waits on disk, drains once, and the issue is put back", async ({ page }) => {
  test.skip(MODE !== "dev", "the field client dials the workspace's own port through a line of its own; behind the gateway there is none");
  const run = client("field/field.mts");
  expect(run.code, run.out).toBe(0);
  const lines = run.lines;
  expect(lines).toContain("this device acts for Ada Lovelace");
  expect(lines.find((l) => l.startsWith("the service serves "))).toMatch(/^the service serves live, rb, http, mcp; schema [0-9a-f]{12}…$/);
  // the issue it worked on, by the title the deferred block's first frame carried
  const title = lines.find((l) => / data: /.test(l))!.replace(/^\+\d+ms {2}data: /, "");
  const [moved] = await stored<{ id: string; state: string; version: number }>("select id, state, version from issues where title = $1 and project_id = 'p1'", [title]);
  const back = lines.find((l) => l.startsWith("put it back where it was: moving to "))!.slice("put it back where it was: moving to ".length);
  const next = back === "open" ? "doing" : "open";

  expect(lines).toContain("queue: queued moveIssue (1 waiting)");
  expect(lines.find((l) => l.startsWith("the cache shows "))).toMatch(new RegExp(`^the cache shows "${title}" as ${next}: predicted, not yet true, 1 command\\(s\\) queued on disk at .+keel-field-ada\\.json$`));
  expect(lines).toContain("queue: sent moveIssue (0 waiting)");
  // sent once when the line came back; the second drain sends nothing, the key spent
  expect(lines.filter((l) => l.startsWith("sent; "))).toEqual([`sent; 0 left. the server says "${title}" is ${next}, version ${moved!.version - 1}`]);
  expect(lines).toContain("a second drain sends nothing (0 left): the key was spent, a retry would replay");
  // and put back: where it was, two versions on
  expect(moved!.state).toBe(back);

  await signIn(page, ADA);
  // both moves, on the feed a browser reads, newest first: the one the queue drained, and the one that put it back
  await expect.poll(async () => (await feedLines(page, title)).slice(0, 2)).toEqual([`Ada Lovelace | moved | ${title} | ${next} → ${back}`, `Ada Lovelace | moved | ${title} | ${back} → ${next}`]);
});
