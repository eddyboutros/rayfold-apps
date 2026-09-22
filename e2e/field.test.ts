import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RayfoldClientError } from "@rayfold/client";
import { canonicalShape, parseShapeText, shapeIdOf } from "@rayfold/schema";
import { Line, fieldClient, fileQueue } from "../clients/field/lib.mts";
import { startTestService, type TestService } from "./harness.ts";
import { until } from "./wait.ts";

/**
 * The field client against the workspace: Rayfold Binary over one socket, a shape that defers its thread, commands
 * queued while the line is cut and drained with their keys when it is back, and the schema's merge policy on the
 * prediction shown meanwhile.
 */
let svc: TestService;
let line: Line;
let dir: string;
const PROJECT = "p1";

beforeAll(async () => {
  svc = await startTestService("workspace");
  const port = Number(new URL(svc.base).port);
  line = new Line("127.0.0.1", port);
  await line.start();
  dir = await mkdtemp(join(tmpdir(), "field-"));
});
afterAll(async () => {
  await line?.stop();
  await svc?.stop();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await svc.reset();
  line.restore();
});

interface Issue {
  id: string;
  title: string;
  state: string;
  version: number;
  comments?: { items: Array<{ body: string }> };
}

const field = (binary: boolean, queuePath = join(dir, `${binary ? "rb" : "json"}.json`)) =>
  fieldClient({ httpBase: svc.base, wsUrl: `ws://127.0.0.1:${line.port}/rayfold/ws`, who: "ada", binary, queue: fileQueue(queuePath) });

it("speaks Rayfold Binary over the socket, and the identity on the URL is the same person as a bearer", async () => {
  const { client, manifest } = await field(true);
  expect(manifest.extensions).toEqual(expect.arrayContaining(["live", "rb"]));
  expect(await client.query("me", {}, { shape: "{ id name }" })).toEqual({ $type: "Member", id: "u1", name: "Ada Lovelace" });
  // the same answer as JSON text on the same socket: the encoding is the wire's business, not the result's
  const { client: plain } = await field(false);
  const made = await client.command<Issue>("createIssue", { projectId: PROJECT, title: "Count the pallets" }, { shape: "{ id title state version }" });
  expect(await plain.query<Issue>("issue", { id: made.id }, { shape: "{ id title state version }" })).toEqual({ $type: "Issue", ...made });
});

it("a deferred block arrives after the frame that carries the rest, and the client hands back the whole", async () => {
  const { client } = await field(true);
  const issue = await client.command<Issue>("createIssue", { projectId: PROJECT, title: "Count the pallets" }, { shape: "{ id version }" });
  await client.command("addComment", { issueId: issue.id, body: "Bay 3 first." }, { shape: "{ id }" });
  const batch = client.batch();
  const order: string[] = [];
  const op = batch.query<Issue>("issue", { id: issue.id }, { shape: '{ id title state version @defer(label: "thread") { comments { items { body } } } }' });
  await batch.run({ onFrame: (f) => order.push("at" in f ? "thread" : "data" in f ? "issue" : "fin" in f ? "fin" : "other") });
  // the issue itself first, without the thread; the thread in later frames addressed to its place (the block, then
  // the lazy field inside it), and fin once everything has arrived
  expect(order[0]).toBe("issue");
  expect(order.at(-1)).toBe("fin");
  expect(order.slice(1, -1).length).toBeGreaterThan(0);
  expect(order.slice(1, -1).every((f) => f === "thread")).toBe(true);
  const whole = await op.promise;
  expect(whole.title).toBe("Count the pallets");
  expect(whole.comments?.items.map((c) => c.body)).toEqual(["Bay 3 first."]);
});

it("commands made while the line is cut wait on disk with their keys, show their prediction, and go out once when the line is back", async () => {
  const queuePath = join(dir, "offline.json");
  const { client } = await field(true, queuePath);
  const issue = await client.command<Issue>("createIssue", { projectId: PROJECT, title: "Count the pallets" }, { shape: "{ id title state version }" });
  await client.query<Issue>("issue", { id: issue.id }, { shape: "{ id title state version }" });

  line.cut();
  const events: string[] = [];
  client.onQueue((e) => events.push(`${e.type}:${e.pending}`));
  const moved = client.command<Issue>("moveIssue", { id: issue.id, to: "doing" }, {
    shape: "{ id title state version }",
    ifVersion: issue.version,
    optimistic: [{ set: `Issue:${issue.id}`, value: { state: "doing" } }],
  });
  moved.catch(() => undefined);
  await until("the move to be queued", () => (client.queued.length === 1 ? true : undefined));
  // the prediction is what the device shows, and the queue is on disk, key and all
  expect(client.cache.get(`Issue:${issue.id}`)?.["state"]).toBe("doing");
  const onDisk = JSON.parse(await readFile(queuePath, "utf8")) as Array<{ op: string; key: string }>;
  expect(onDisk.map((c) => c.op)).toEqual(["moveIssue"]);
  expect(onDisk[0]!.key.length).toBeGreaterThanOrEqual(16);
  // the server never heard it
  expect(await svc.client("grace").query<Issue>("issue", { id: issue.id }, { shape: "{ state }" })).toMatchObject({ state: "open" });

  line.restore();
  expect(await client.drain()).toBe(0);
  expect(await moved).toMatchObject({ state: "doing", version: issue.version + 1 });
  expect(await svc.client("grace").query<Issue>("issue", { id: issue.id }, { shape: "{ state version }" })).toMatchObject({ state: "doing", version: issue.version + 1 });
  expect(events).toEqual(["queued:1", "sent:0"]);
  // guard: a second drain has nothing to send, and the command ran once: one feed line for the move
  expect(await client.drain()).toBe(0);
  const feed = await svc.client("grace").query<{ items: Array<{ kind: string }> }>("activity", { projectId: PROJECT }, { shape: "{ items { kind } }" });
  expect(feed.items.filter((l) => l.kind === "issue.moved")).toHaveLength(1);
});

it("a queued command the server refuses when it finally arrives is failed, not retried forever", async () => {
  const { client } = await field(true, join(dir, "refused.json"));
  const issue = await client.command<Issue>("createIssue", { projectId: PROJECT, title: "Count the pallets" }, { shape: "{ id version }" });
  // someone else moves it while the device is offline
  line.cut();
  const stale = client.command<Issue>("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id }", ifVersion: issue.version });
  stale.catch(() => undefined);
  await until("the move to be queued", () => (client.queued.length === 1 ? true : undefined));
  await svc.client("grace").command("moveIssue", { id: issue.id, to: "doing" }, { shape: "{ id }", ifVersion: issue.version });
  line.restore();
  expect(await client.drain()).toBe(0);
  const refused = await stale.then(() => null, (e: RayfoldClientError) => e);
  expect(refused).toMatchObject({ code: "failed_precondition", type: "VersionConflict" });
  expect(client.queued).toHaveLength(0);
});

it("with trusted shapes on, a shape the service registered is served and one it never saw is refused", async () => {
  const trusted = await startTestService("workspace", { TRUSTED_SHAPES: "1" }, 7);
  try {
    const ada = trusted.client("ada");
    // in trusted mode a shape travels as its id: the text of one the panels send, hashed as the server hashes it
    const idOf = (text: string) => shapeIdOf(canonicalShape(parseShapeText(text), () => undefined)); // already sha256:-prefixed
    expect(Array.isArray(await ada.query("members", {}, { shape: idOf("{ id name }") }))).toBe(true);
    // the same text inline is refused, as is the id of a shape nobody registered
    const inline = await ada.query("members", {}, { shape: "{ id name }" }).then(() => null, (e: RayfoldClientError) => e);
    expect(inline?.code).toBe("permission_denied");
    const unknown = await ada.query("members", {}, { shape: idOf("{ id name email }") }).then(() => null, (e: RayfoldClientError) => e);
    expect(unknown?.code).toBe("not_found"); // an id nobody registered names nothing, whichever mode
    // guard: the manifest says which mode each instance is in
    const manifest = (await (await fetch(`${trusted.base}/rayfold/manifest`)).json()) as { limits: { trustedShapes: boolean } };
    expect(manifest.limits.trustedShapes).toBe(true);
    expect(((await (await fetch(`${svc.base}/rayfold/manifest`)).json()) as { limits: { trustedShapes: boolean } }).limits.trustedShapes).toBe(false);
  } finally {
    await trusted.stop();
  }
});
