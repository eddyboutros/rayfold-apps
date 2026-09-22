/**
 * An agent on the workspace, run against the dev fleet: what a program with a scoped token can and cannot do.
 *
 *   npm run agent                       # the workspace on :4002, acting for ada
 *   WORKSPACE_URL=… WHO=grace npm run agent
 *
 * Nothing here is a Rayfold client. It is an MCP client: JSON-RPC over HTTP, the bridge every Rayfold server is.
 */
import { Mcp, mintAgentToken } from "./lib.mts";

const WORKSPACE_URL = (process.env["WORKSPACE_URL"] ?? "http://localhost:4002").replace(/\/$/, "");
const WHO = process.env["WHO"] ?? "ada";
const PROJECT = process.env["PROJECT"] ?? "p1";

const say = (line: string) => console.log(line);
const step = (n: number, what: string) => console.log(`\n${n}. ${what}`);
const text = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n").split("\n").map((l) => `   ${l}`).join("\n");

step(1, `${WHO} mints a token for the agent: three operations, fifteen minutes`);
const scoped = await mintAgentToken(WORKSPACE_URL, WHO, ["me", "issues", "createIssue", "addComment"]);
say(`   ops ${scoped.ops.join(", ")}; expires ${new Date(scoped.expiresAt).toLocaleTimeString()}`);
const mcp = new Mcp(WORKSPACE_URL, scoped.token);

step(2, "tools/list: every command is a tool with a .simulate twin, every query a tool");
const { tools } = await mcp.tools();
say(`   ${tools.length} tools, among them: ${tools.slice(0, 8).map((t) => t.name).join(", ")}…`);

step(3, "resources/read rayfold://query/me: who the agent is");
say(text({ content: [{ text: (await mcp.read("rayfold://query/me")).contents[0]?.text ?? "" }] }));

step(4, "A dry run: createIssue.simulate answers with what would happen, and writes nothing");
const dry = await mcp.use("createIssue.simulate", { projectId: PROJECT, title: "Agent: check the EDI mapping" });
say(text(dry));

step(5, "The real thing: createIssue, then a note on it");
const made = await mcp.use("createIssue", { projectId: PROJECT, title: "Agent: check the EDI mapping" });
const created = (made.structuredContent?.["result"] as { id: string } | undefined)?.id;
say(`   created ${created}`);
if (created) say(text(await mcp.use("addComment", { issueId: created, body: "Opened by an agent over MCP, with a scoped token." })));

step(6, "Past the scope: assignIssue is not in the token, and the bridge says so");
const refused = await mcp.use("assignIssue", { id: created ?? "x", assigneeId: "u2" });
say(`   isError ${refused.isError}: ${text(refused).trim()}`);

step(7, "And the token cannot widen itself: mintAgentToken as the agent");
const widen = await mcp.use("mintAgentToken", { ops: ["assignIssue"] });
say(`   isError ${widen.isError}: ${text(widen).trim()}`);
