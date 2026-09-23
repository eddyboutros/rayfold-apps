import { afterEach, describe, expect, it } from "vitest";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { createRayfoldServer, listen, shutdown } from "@rayfold/server";
import { startStandInConsole, type StandInConsole } from "../../../e2e/stand-in-console.ts";
import { signal, until } from "../../../e2e/wait.ts";
import { connectPlatform, type Platform } from "./platform.ts";

/**
 * A service on the platform: configuration that changes under it without a restart, work it takes from a queue and
 * finishes or fails, and traces that leave the process. Against a stand-in with the console's operations, because
 * what is pinned is the service's side of the conversation.
 */
let console_: StandInConsole;
const platforms: Platform[] = [];

afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
  await console_?.stop();
});

// an operator's script: it holds a token the way a service does
const operator = () =>
  new RayfoldClient({ transport: createFetchTransport({ url: `${console_.url}/rayfold`, headers: () => ({ authorization: `Bearer ${console_.token}` }) }) });
const connect = (over: Partial<Parameters<typeof connectPlatform>[0]> = {}) => {
  const p = connectPlatform({ url: console_.url, token: console_.token, app: "documents", environment: "test", instance: "documents-1", log: () => undefined, ...over });
  platforms.push(p);
  return p;
};

describe("configuration", () => {
  it("a value changed in the console reaches the service without a restart", async () => {
    console_ = await startStandInConsole();
    await operator().command("setConfig", { app: "documents", environment: "test", key: "uploads.maxBytes", value: "1024" }, { shape: "{ key }", key: crypto.randomUUID() });

    const platform = connect();
    await platform.config.ready();
    expect(platform.config.number("uploads.maxBytes", 0)).toBe(1024);
    expect(platform.config.get("nothing")).toBeUndefined();
    expect(platform.config.number("nothing", 7)).toBe(7);

    await operator().command("setConfig", { app: "documents", environment: "test", key: "uploads.maxBytes", value: "2048" }, { shape: "{ key }", key: crypto.randomUUID() });
    await until("the new value to arrive", async () => (platform.config.number("uploads.maxBytes", 0) === 2048 ? true : undefined));

    // another app's configuration is not this service's
    await operator().command("setConfig", { app: "workspace", environment: "test", key: "uploads.maxBytes", value: "9" }, { shape: "{ key }", key: crypto.randomUUID() });
    await operator().command("setConfig", { app: "documents", environment: "test", key: "marker", value: "x" }, { shape: "{ key }", key: crypto.randomUUID() });
    await until("the marker to arrive", async () => (platform.config.get("marker") === "x" ? true : undefined));
    expect(platform.config.number("uploads.maxBytes", 0)).toBe(2048);
  });

  it("a secret's value never reaches the service through config()", async () => {
    console_ = await startStandInConsole();
    await operator().command("setConfig", { app: "documents", environment: "test", key: "smtp.password", value: "hunter2", secret: true }, { shape: "{ key }", key: crypto.randomUUID() });
    const platform = connect();
    await platform.config.ready();
    expect(platform.config.get("smtp.password")).toBeUndefined();
    expect(JSON.stringify(platform.config.snapshot())).not.toContain("hunter2");
  });

  it("a console's url without its token is no platform: the service says so and runs alone rather than being refused at every turn", async () => {
    console_ = await startStandInConsole();
    const said: string[] = [];
    const platform = connectPlatform({ url: console_.url, app: "documents", environment: "test", instance: "documents-1", log: (l) => said.push(l) });
    platforms.push(platform);
    await platform.config.ready();
    expect(platform.connected).toBe(false);
    expect(said.some((l) => l.includes("CONSOLE_TOKEN is not"))).toBe(true);
    expect(await platform.enqueue("extract-text", { documentId: "d1" })).toBeNull();
    // guard: with the token the same console is a platform
    const on = connect();
    await on.config.ready();
    expect(on.connected).toBe(true);
  });

  it("without a console a service has its defaults, and is not held back", async () => {
    const platform = connectPlatform({ app: "documents", environment: "test", instance: "documents-1", log: () => undefined });
    platforms.push(platform);
    await platform.config.ready();
    expect(platform.connected).toBe(false);
    expect(platform.config.number("uploads.maxBytes", 5)).toBe(5);
    expect(await platform.enqueue("extract-text", { documentId: "d1" })).toBeNull();
    expect(platform.instrumentation).toBeUndefined();
  });
});

describe("traces", () => {
  it("a batch served with the platform's hook leaves the process as spans the console receives", async () => {
    console_ = await startStandInConsole();
    const platform = connect();
    // a service with the hook, as service-kit wires it
    const server = createRayfoldServer({
      schema: `entity Thing { id: ID  name: String }  query thing(id: ID): Thing?`,
      resolvers: { Query: { thing: ({ id }: { id: string }) => ({ id, name: "one" }) } },
      instrumentation: platform.instrumentation!,
    });
    const http = await listen(server, 0);
    try {
      const port = (http.address() as { port: number }).port;
      const client = new RayfoldClient({ transport: createFetchTransport({ url: `http://127.0.0.1:${port}/rayfold` }), client: "test-client/1" });
      expect(await client.query("thing", { id: "t1" }, { shape: "{ name }" })).toMatchObject({ name: "one" });
    } finally {
      await shutdown(server, http, { timeoutMs: 1_000, flushMs: 50 });
    }

    // stopping the platform flushes the exporter; nothing is asserted on a timer
    await platform.stop();
    const names = (console_.traces as Array<{ resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans: Array<{ spans: Array<{ name: string }> }> }> }>)
      .flatMap((t) => t.resourceSpans)
      .flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.map((sp) => sp.name)));
    expect(names).toContain("rayfold batch");
    expect(names).toContain("rayfold query thing");
    const service = (console_.traces as Array<{ resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }> }>)[0]!.resourceSpans[0]!.resource.attributes.find((a) => a.key === "service.name");
    expect(service?.value.stringValue).toBe("documents");
  });
});

describe("logs", () => {
  it("a line the service writes reaches the console, and one written while serving a batch carries its trace", async () => {
    console_ = await startStandInConsole();
    const platform = connect();
    platform.log.info("the service started", { port: 4001 });
    platform.log.warn("the mirror lags", { seconds: 240 });

    // a resolver writing a line: the line and the batch's span share a trace id, which is what makes the console
    // show the line under the request
    const server = createRayfoldServer({
      schema: `entity Thing { id: ID  name: String }  query thing(id: ID): Thing?`,
      resolvers: {
        Query: {
          thing: ({ id }: { id: string }) => {
            platform.log.info("looked up a thing", { id });
            return { id, name: "one" };
          },
        },
      },
      instrumentation: platform.instrumentation!,
    });
    const http = await listen(server, 0);
    try {
      const port = (http.address() as { port: number }).port;
      await new RayfoldClient({ transport: createFetchTransport({ url: `http://127.0.0.1:${port}/rayfold` }) }).query("thing", { id: "t1" }, { shape: "{ name }" });
    } finally {
      await shutdown(server, http, { timeoutMs: 1_000, flushMs: 50 });
    }
    await platform.stop();

    expect(console_.logs.map((l) => [l.service, l.severity, l.body])).toEqual([
      ["documents", "INFO", "the service started"],
      ["documents", "WARN", "the mirror lags"],
      ["documents", "INFO", "looked up a thing"],
    ]);
    expect(console_.logs[1]?.attributes).toMatchObject({ seconds: 240 });
    const inBatch = console_.logs[2]!;
    expect(inBatch.traceId).toBeTruthy();
    const spanTraces = (console_.traces as Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; name: string }> }> }> }>)
      .flatMap((t) => t.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    expect(spanTraces.find((s) => s.name === "rayfold query thing")?.traceId).toBe(inBatch.traceId);
    // guard: a line written outside any batch has no trace to belong to
    expect(console_.logs[0]?.traceId).toBeNull();
  });
});

describe("the queue", () => {
  it("a job put on the queue is taken by a worker, finished with its result, and not run twice", async () => {
    console_ = await startStandInConsole();
    const producer = connect({ instance: "documents-1" });
    const consumer = connect({ app: "catalogue", instance: "catalogue-1" });

    const seen = signal<{ id: string; payload: unknown }>();
    const runs: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    consumer.work<{ documentId: string }>(
      "extract-text",
      async (job) => {
        runs.push(job.id);
        seen.fire(job);
        await held;
        return { words: 3 };
      },
      { idleMs: 50 },
    );

    const put = await producer.enqueue("extract-text", { documentId: "d1" }, { key: "d1:1" });
    expect(put).not.toBeNull();
    const job = await seen.wait("the worker to take the job");
    expect(job).toMatchObject({ id: put!.id, payload: { documentId: "d1" } });

    // the same key while the first is unfinished: the queue answers the job already there, and nothing runs twice
    const again = await producer.enqueue("extract-text", { documentId: "d1" }, { key: "d1:1" });
    expect(again).toEqual({ id: put!.id });

    release();
    await until("the job to be done", async () => (console_.jobs.find((j) => j.id === put!.id)?.state === "done" ? true : undefined));
    expect(console_.jobs.find((j) => j.id === put!.id)).toMatchObject({ result: { words: 3 }, worker: "catalogue-1", attempts: 1 });
    expect(runs).toEqual([put!.id]);
  });

  it("a handler that throws fails the job, and the queue retries it until its limit", async () => {
    console_ = await startStandInConsole();
    const producer = connect();
    const consumer = connect({ app: "catalogue", instance: "catalogue-1" });
    await consumer.defineQueue("extract-text", { maxAttempts: 2 });

    let attempts = 0;
    consumer.work("extract-text", async () => {
      attempts++;
      throw new Error("the file is not there");
    }, { idleMs: 30 });

    const put = await producer.enqueue("extract-text", { documentId: "gone" });
    await until("the job to be dead", async () => (console_.jobs.find((j) => j.id === put!.id)?.state === "dead" ? true : undefined));
    expect(attempts).toBe(2);
    expect(console_.jobs.find((j) => j.id === put!.id)).toMatchObject({ error: "the file is not there", attempts: 2 });
  });

  it("a console that is down holds nothing back: the service has its defaults, and a worker keeps asking until it is back", async () => {
    // where a console was, and is not any more
    const gone = await startStandInConsole();
    const port = Number(new URL(gone.url).port);
    await gone.stop();

    const said: string[] = [];
    const platform = connectPlatform({ url: gone.url, token: gone.token, app: "catalogue", environment: "test", instance: "catalogue-1", log: (l) => said.push(l) });
    platforms.push(platform);
    let ready = false;
    void platform.config.ready().then(() => (ready = true));
    await until("configuration to be ready with no console to answer", () => ready || undefined);
    expect(platform.connected).toBe(true);
    expect(platform.config.snapshot()).toEqual({});
    expect(platform.config.number("uploads.maxBytes", 5)).toBe(5);

    const ran: string[] = [];
    platform.work("extract-text", async (job) => {
      ran.push(job.id);
      return "taken";
    }, { idleMs: 30 });
    // refused by the network, and asking again rather than giving up
    await until("the worker to have asked twice", () => said.filter((l) => l.startsWith("queue extract-text: could not claim")).length >= 2 || undefined);
    expect(ran).toEqual([]);

    // the console is back where it was: the worker takes what is put on the queue, and configuration arrives again
    console_ = await startStandInConsole(Date.now, port);
    const put = await operator().command<{ id: string }>("enqueue", { queue: "extract-text", payload: { documentId: "d1" } }, { shape: "{ id }", key: crypto.randomUUID() });
    await until("the job to be done", () => (console_.jobs.find((j) => j.id === put.id)?.state === "done" ? true : undefined));
    expect(console_.jobs.find((j) => j.id === put.id)).toMatchObject({ result: "taken", worker: "catalogue-1", attempts: 1 });
    expect(ran).toEqual([put.id]);
    await operator().command("setConfig", { app: "catalogue", environment: "test", key: "uploads.maxBytes", value: "1024" }, { shape: "{ key }", key: crypto.randomUUID() });
    await until("the value to arrive once the console is back", () => (platform.config.number("uploads.maxBytes", 5) === 1024 ? true : undefined));
  });

  it("a job stays with the worker running it while another polls, and a dead worker's job is taken over", async () => {
    // the console's clock, so a lease lapses when the test says and not when the machine is slow
    let clock = 1_000_000;
    console_ = await startStandInConsole(() => clock);
    const producer = connect();
    const a = connect({ app: "catalogue", instance: "catalogue-a" });
    const b = connect({ app: "catalogue", instance: "catalogue-b" });

    const started = signal<string>();
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const ranOn: string[] = [];
    a.work("extract-text", async (job) => {
      ranOn.push("a");
      started.fire(job.id);
      await held;
      return "a";
    }, { leaseMs: 300, idleMs: 30 });

    const put = await producer.enqueue("extract-text", { documentId: "slow" });
    await started.wait("worker a to start");
    // b arrives while a is working. a renews its lease as it goes; b keeps asking and is handed nothing
    b.work("extract-text", async () => {
      ranOn.push("b");
      return "b";
    }, { leaseMs: 300, idleMs: 30 });
    await until("a renewal", async () => (console_.beats.filter((id) => id === put!.id).length >= 2 ? true : undefined));
    release();
    await until("the job to be done", async () => (console_.jobs.find((j) => j.id === put!.id)?.state === "done" ? true : undefined));
    expect(ranOn).toEqual(["a"]);
    expect(console_.jobs.find((j) => j.id === put!.id)).toMatchObject({ result: "a", worker: "catalogue-a" });

    // guard: a worker that dies stops renewing, its lease lapses, and the job is taken over rather than stuck
    const stuck = connect({ app: "catalogue", instance: "catalogue-stuck" });
    const stuckStarted = signal<string>();
    stuck.work("extract-text", async (job) => {
      stuckStarted.fire(job.id);
      return new Promise<unknown>(() => undefined); // never finishes
    }, { leaseMs: 300, idleMs: 30 });
    await a.stop();
    await b.stop();
    const second = await producer.enqueue("extract-text", { documentId: "stuck" });
    await stuckStarted.wait("the stuck worker to start");
    await stuck.stop(); // as a crash would: no more renewals
    clock += 10_000; // past any lease it held

    const c = connect({ app: "catalogue", instance: "catalogue-c" });
    c.work("extract-text", async () => "c", { leaseMs: 300, idleMs: 30 });
    await until("the lapsed job to be taken over", async () => (console_.jobs.find((j) => j.id === second!.id)?.state === "done" ? true : undefined));
    expect(console_.jobs.find((j) => j.id === second!.id)).toMatchObject({ result: "c", worker: "catalogue-c", attempts: 2 });
  });
});
