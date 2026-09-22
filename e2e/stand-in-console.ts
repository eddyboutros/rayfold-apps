/**
 * The console, as far as a service can tell: its `config` live query and its queue commands, served by a small
 * Rayfold server in memory. The real console is a separate product; a test here needs only the operations a service
 * calls, and needs them to behave as the console's do — a config change re-runs the live query, a claim hands a job
 * to one worker, a lapsed lease is taken over.
 */
import { createHttpHandler, createRayfoldServer, ok, shutdown, type RayfoldServer, type Resolvers } from "@rayfold/server";
import { createServer, type Server } from "node:http";

const SCHEMA = `
object ConfigEntry { app: String  environment: String  key: String  value: String?  secret: Boolean  version: Int }
query config(app: String, environment: String): [ConfigEntry] @live
command setConfig(app: String, environment: String, key: String, value: String, secret: Boolean = false): ConfigEntry
command removeConfig(app: String, environment: String, key: String): ConfigEntry?

object Queue { name: String  maxAttempts: Int  leaseMs: Long  backoffMs: Long }
object Job { id: ID  queue: String  payload: JSON  result: JSON?  state: String  attempts: Int  maxAttempts: Int  worker: String?  key: String?  error: String? }
object Claimed { job: Job  token: String  leaseUntil: Long }
query jobs(queue: String?, state: String?, limit: Int = 50): [Job]
command defineQueue(name: String, maxAttempts: Int?, leaseMs: Long?, backoffMs: Long?, paused: Boolean?): Queue
command enqueue(queue: String, payload: JSON?, key: String?, priority: Int = 0, delayMs: Long = 0, after: [ID] = []): Job
command claim(queue: String, worker: String, leaseMs: Long?): Claimed?
command heartbeat(id: ID, token: String, leaseMs: Long?): Job
command completeJob(id: ID, token: String, result: JSON?): Job
command failJob(id: ID, token: String, error: String, retry: Boolean = true): Job
`;

interface Entry {
  app: string;
  environment: string;
  key: string;
  value: string;
  secret: boolean;
  version: number;
}

interface JobRow {
  id: string;
  queue: string;
  payload: unknown;
  result: unknown;
  state: "ready" | "running" | "done" | "dead";
  attempts: number;
  maxAttempts: number;
  worker: string | null;
  key: string | null;
  error: string | null;
  token: string | null;
  leaseUntil: number | null;
}

export interface StandInConsole {
  url: string;
  server: RayfoldServer;
  entries: Entry[];
  jobs: JobRow[];
  /** Traces received on the OTLP route, one resourceSpans payload per export. */
  traces: unknown[];
  /** The id of the job behind every heartbeat, in order. */
  beats: string[];
  stop(): Promise<void>;
}

export async function startStandInConsole(now: () => number = Date.now): Promise<StandInConsole> {
  const entries: Entry[] = [];
  const jobs: JobRow[] = [];
  const traces: unknown[] = [];
  const beats: string[] = [];
  const queues = new Map<string, { maxAttempts: number; leaseMs: number; backoffMs: number }>();
  const queueOf = (name: string) => queues.get(name) ?? { maxAttempts: 3, leaseMs: 30_000, backoffMs: 1_000 };
  const changed = [{ invOp: ["config"] }];
  const toJob = (j: JobRow) => ({ $type: "Job", id: j.id, queue: j.queue, payload: j.payload, result: j.result, state: j.state, attempts: j.attempts, maxAttempts: j.maxAttempts, worker: j.worker, key: j.key, error: j.error });
  const held = (id: string, token: string): JobRow => {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.token !== token || job.state !== "running") throw new Error(`job ${id} is not held with this token`);
    return job;
  };

  const resolvers: Resolvers = {
    Query: {
      config: ({ app, environment }: { app: string; environment: string }) => entries.filter((e) => e.app === app && e.environment === environment).map((e) => ({ $type: "ConfigEntry", ...e, value: e.secret ? null : e.value })),
      jobs: ({ queue, state, limit }: { queue?: string | null; state?: string | null; limit: number }) =>
        jobs.filter((j) => (!queue || j.queue === queue) && (!state || j.state === state)).slice(-limit).reverse().map(toJob),
    },
    Command: {
      setConfig: ({ app, environment, key, value, secret }: Entry) => {
        const existing = entries.find((e) => e.app === app && e.environment === environment && e.key === key);
        const entry = existing ? Object.assign(existing, { value, secret, version: existing.version + 1 }) : { app, environment, key, value, secret, version: 1 };
        if (!existing) entries.push(entry);
        return ok({ $type: "ConfigEntry", ...entry, value: secret ? null : value }, { patch: changed });
      },
      removeConfig: ({ app, environment, key }: { app: string; environment: string; key: string }) => {
        const i = entries.findIndex((e) => e.app === app && e.environment === environment && e.key === key);
        const [gone] = i >= 0 ? entries.splice(i, 1) : [];
        return ok(gone ? { $type: "ConfigEntry", ...gone } : null, { patch: changed });
      },
      defineQueue: ({ name, maxAttempts, leaseMs, backoffMs }: { name: string; maxAttempts?: number | null; leaseMs?: number | null; backoffMs?: number | null }) => {
        const q = { ...queueOf(name), ...(maxAttempts ? { maxAttempts } : {}), ...(leaseMs ? { leaseMs } : {}), ...(backoffMs ? { backoffMs } : {}) };
        queues.set(name, q);
        return { $type: "Queue", name, ...q };
      },
      enqueue: ({ queue, payload, key }: { queue: string; payload: unknown; key?: string | null }) => {
        const open = key ? jobs.find((j) => j.queue === queue && j.key === key && j.state !== "done" && j.state !== "dead") : undefined;
        if (open) return toJob(open);
        const job: JobRow = { id: crypto.randomUUID(), queue, payload, result: null, state: "ready", attempts: 0, maxAttempts: queueOf(queue).maxAttempts, worker: null, key: key ?? null, error: null, token: null, leaseUntil: null };
        jobs.push(job);
        return toJob(job);
      },
      claim: ({ queue, worker, leaseMs }: { queue: string; worker: string; leaseMs?: number | null }) => {
        const lease = leaseMs ?? queueOf(queue).leaseMs;
        const job = jobs.find((j) => j.queue === queue && (j.state === "ready" || (j.state === "running" && (j.leaseUntil ?? 0) < now())));
        if (!job) return null;
        Object.assign(job, { state: "running", worker, token: crypto.randomUUID(), leaseUntil: now() + lease, attempts: job.attempts + 1 });
        return { $type: "Claimed", job: toJob(job), token: job.token, leaseUntil: job.leaseUntil };
      },
      heartbeat: ({ id, token, leaseMs }: { id: string; token: string; leaseMs?: number | null }) => {
        const job = held(id, token);
        job.leaseUntil = now() + (leaseMs ?? queueOf(job.queue).leaseMs);
        beats.push(job.id);
        return toJob(job);
      },
      completeJob: ({ id, token, result }: { id: string; token: string; result: unknown }) => {
        const job = held(id, token);
        Object.assign(job, { state: "done", result: result ?? null, token: null, leaseUntil: null });
        return toJob(job);
      },
      failJob: ({ id, token, error, retry }: { id: string; token: string; error: string; retry: boolean }) => {
        const job = held(id, token);
        const dead = !retry || job.attempts >= job.maxAttempts;
        Object.assign(job, { state: dead ? "dead" : "ready", error, token: null, leaseUntil: null });
        return toJob(job);
      },
    },
  };

  const server = createRayfoldServer({ schema: SCHEMA, resolvers });
  // whoever reaches the console is an operator, as the console itself has it today; a keyed command needs a caller
  // to scope its idempotency record to, so this is not optional
  const rayfold = createHttpHandler(server, { viewer: () => ({ id: "operator" }) });
  // the OTLP route beside the Rayfold one, as the console has it: JSON in, 200 out, kept for a test to look at
  const http: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/otlp/v1/traces") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        traces.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
      return;
    }
    void rayfold(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    entries,
    jobs,
    traces,
    beats,
    stop: () => shutdown(server, http, { timeoutMs: 2_000, flushMs: 50 }),
  };
}
