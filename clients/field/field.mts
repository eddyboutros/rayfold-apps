/**
 * The field client, run against the dev fleet: a device on a bad line, and what Rayfold does about it.
 *
 *   npm run field                       # the workspace on :4002, as ada
 *   WORKSPACE_URL=… WHO=grace npm run field
 *
 * It says what it does as it goes. The line it talks over is its own TCP relay, so it cuts and restores the
 * connection itself; the service is never touched.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Line, fieldClient, fileQueue } from "./lib.mts";

const WORKSPACE_URL = (process.env["WORKSPACE_URL"] ?? "http://localhost:4002").replace(/\/$/, "");
const WHO = process.env["WHO"] ?? "ada";
const PROJECT = process.env["PROJECT"] ?? "p1";

interface Issue {
  id: string;
  title: string;
  state: string;
  version: number;
  comments?: { items: Array<{ body: string; by: { name: string } | null }> };
}

const say = (line: string) => console.log(line);
const step = (n: number, what: string) => console.log(`\n${n}. ${what}`);

const target = new URL(WORKSPACE_URL);
const line = new Line(target.hostname, Number(target.port || 80));
const port = await line.start();
const queuePath = join(tmpdir(), `keel-field-${WHO}.json`);
await rm(queuePath, { force: true });

step(1, "Connect over one WebSocket, in Rayfold Binary");
const { client, manifest } = await fieldClient({ httpBase: WORKSPACE_URL, wsUrl: `ws://127.0.0.1:${port}/rayfold/ws`, who: WHO, binary: true, queue: fileQueue(queuePath) });
say(`   the service serves ${manifest.extensions.join(", ")}; schema ${manifest.schemaHash.slice(0, 12)}…`);
say(`   frames on the socket are RB bytes, decoded with that schema, so a field name costs one small integer on the wire`);
const me = await client.query<{ id: string; name: string }>("me", {}, { shape: "{ id name }" });
say(`   this device acts for ${me.name}`);

step(2, "A deferred block: the list first, the conversation after");
const first = (await client.query<{ items: Issue[] }>("issues", { projectId: PROJECT, page: { first: 3 } }, { shape: "{ items { id title state version } }" })).items;
if (!first.length) {
  say("   no issues on the project; seed the fleet first (npm run seed)");
  await line.stop();
  process.exit(0);
}
const issue = first[0]!;
const batch = client.batch();
const t0 = Date.now();
const op = batch.query<Issue>("issue", { id: issue.id }, { shape: '{ id title state version @defer(label: "thread") { comments { items { body by { name } } } } }' });
await batch.run({ onFrame: (f) => say(`   +${Date.now() - t0}ms  ${"at" in f ? `at ${JSON.stringify(f.at)}: the thread` : "data" in f ? `data: ${(f as { data: Issue }).data.title}` : "fin"}`) });
const whole = await op.promise;
say(`   ${whole.comments?.items.length ?? 0} comment(s) arrived after the issue itself`);

step(3, "The line goes down; a move is made anyway");
line.cut();
const next = issue.state === "open" ? "doing" : "open";
client.onQueue((e) => say(`   queue: ${e.type} ${e.command.op} (${e.pending} waiting)`));
const moved = client.command<Issue>("moveIssue", { id: issue.id, to: next }, {
  shape: "{ id title state version }",
  ifVersion: issue.version,
  // what the screen shows at once, from the schema's own idea of the change: Issue.state is @merge(serverWins)
  optimistic: [{ set: `Issue:${issue.id}`, value: { state: next } }],
});
moved.catch(() => undefined);
await new Promise((r) => setTimeout(r, 300));
const predicted = client.cache.get(`Issue:${issue.id}`);
say(`   the cache shows "${issue.title}" as ${String(predicted?.["state"])}: predicted, not yet true, ${client.queued.length} command(s) queued on disk at ${queuePath}`);

step(4, "The line comes back; the queue drains with the same idempotency keys");
line.restore();
const left = await client.drain();
const settled = await moved;
say(`   sent; ${left} left. the server says "${settled.title}" is ${settled.state}, version ${settled.version}`);
const again = await client.drain();
say(`   a second drain sends nothing (${again} left): the key was spent, a retry would replay`);

step(5, "Done");
say(`   put it back where it was: moving to ${issue.state}`);
await client.command("moveIssue", { id: issue.id, to: issue.state }, { shape: "{ id }", ifVersion: settled.version });
await line.stop();
await rm(queuePath, { force: true });
process.exit(0);
