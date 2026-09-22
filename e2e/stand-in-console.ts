/**
 * The console, as far as a service can tell: its `config` live query, its queue and its flows, served by a small
 * Rayfold server in memory. The real console is a separate product; a test here needs only the operations a service
 * calls, and needs them to behave as the console's do — a config change re-runs the live query, a claim hands a job
 * to one worker and never two with the same lock, a lapsed lease is taken over, a step runs when the steps before it
 * are done and its condition holds, and is skipped otherwise, with what came before in its payload.
 */
import { createHttpHandler, createRayfoldServer, ok, shutdown, type RayfoldServer, type Resolvers } from "@rayfold/server";
import { createServer, type Server } from "node:http";

const SCHEMA = `
object ConfigEntry { app: String  environment: String  key: String  value: String?  secret: Boolean  version: Int }
query config(app: String, environment: String): [ConfigEntry] @live
command setConfig(app: String, environment: String, key: String, value: String, secret: Boolean = false): ConfigEntry
command removeConfig(app: String, environment: String, key: String): ConfigEntry?

object Queue { name: String  maxAttempts: Int  leaseMs: Long  backoffMs: Long  concurrency: Int?  timeoutMs: Long? }
object Job { id: ID  queue: String  payload: JSON  result: JSON?  state: String  attempts: Int  maxAttempts: Int  worker: String?  key: String?  error: String?  step: String?  flowRun: ID?  lock: String? }
object Claimed { job: Job  token: String  leaseUntil: Long }
object Flow { name: String  steps: JSON }
object FlowRun { id: ID  name: String  key: String?  state: String  total: Int  done: Int  skipped: Int  dead: Int  running: Int }
query jobs(queue: String?, state: String?, flowRun: ID?, limit: Int = 50): [Job]
query flowRuns(name: String?, limit: Int = 50): [FlowRun]
command defineQueue(name: String, maxAttempts: Int?, leaseMs: Long?, backoffMs: Long?, paused: Boolean?, concurrency: Int?, timeoutMs: Long?): Queue
command enqueue(queue: String, payload: JSON?, key: String?, priority: Int = 0, delayMs: Long = 0, after: [ID] = [], lock: String?, timeoutMs: Long?, maxAttempts: Int?, onFailure: String?): Job
command claim(queue: String, worker: String, leaseMs: Long?): Claimed?
command heartbeat(id: ID, token: String, leaseMs: Long?): Job
command completeJob(id: ID, token: String, result: JSON?): Job
command failJob(id: ID, token: String, error: String, retry: Boolean = true): Job
command defineFlow(name: String, steps: JSON): Flow
command startFlow(name: String, payload: JSON?, key: String?): FlowRun
`;

interface Entry {
  app: string;
  environment: string;
  key: string;
  value: string;
  secret: boolean;
  version: number;
}

interface Condition {
  step: string;
  path?: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  exists?: boolean;
}

interface Step {
  name: string;
  queue: string;
  after?: string[];
  when?: Condition;
  retries?: number;
  lock?: string;
  onFailure?: "abort" | "continue";
}

interface JobRow {
  id: string;
  queue: string;
  payload: unknown;
  result: unknown;
  state: "waiting" | "ready" | "running" | "done" | "skipped" | "dead";
  attempts: number;
  maxAttempts: number;
  worker: string | null;
  key: string | null;
  error: string | null;
  token: string | null;
  leaseUntil: number | null;
  step: string | null;
  flowRun: string | null;
  after: string[];
  when: Condition | null;
  lock: string | null;
  onFailure: "abort" | "continue";
}

interface RunRow {
  id: string;
  name: string;
  key: string | null;
}

export interface StandInConsole {
  url: string;
  server: RayfoldServer;
  entries: Entry[];
  jobs: JobRow[];
  flows: Map<string, Step[]>;
  runs: RunRow[];
  /** Traces received on the OTLP route, one resourceSpans payload per export. */
  traces: unknown[];
  /** The id of the job behind every heartbeat, in order. */
  beats: string[];
  /** Log lines received on the OTLP route, flattened: service, severity, body, and the trace id when there was one. */
  logs: Array<{ service: string; severity: string; body: string; traceId: string | null; attributes: Record<string, unknown> }>;
  stop(): Promise<void>;
}

/** OTLP's resourceLogs / scopeLogs / logRecords, as the console reads them: one row per line. */
function flattenLogs(payload: Record<string, unknown>): StandInConsole["logs"] {
  const out: StandInConsole["logs"] = [];
  const attrs = (list: unknown): Record<string, unknown> =>
    Object.fromEntries(((list as Array<{ key: string; value: Record<string, unknown> }>) ?? []).map((kv) => [kv.key, Object.values(kv.value)[0]]));
  for (const r of (payload["resourceLogs"] as Array<Record<string, unknown>>) ?? []) {
    const service = String(attrs((r["resource"] as Record<string, unknown>)?.["attributes"])["service.name"] ?? "");
    for (const scope of (r["scopeLogs"] as Array<Record<string, unknown>>) ?? []) {
      for (const l of (scope["logRecords"] as Array<Record<string, unknown>>) ?? []) {
        out.push({
          service,
          severity: String(l["severityText"] ?? ""),
          body: String((l["body"] as Record<string, unknown>)?.["stringValue"] ?? ""),
          traceId: l["traceId"] ? String(l["traceId"]) : null,
          attributes: attrs(l["attributes"]),
        });
      }
    }
  }
  return out;
}

function holds(c: Condition, results: Record<string, unknown>): boolean {
  const value = c.path ? c.path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), results[c.step]) : results[c.step];
  const present = value !== undefined && value !== null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (c.exists !== undefined) return c.exists === present;
  if (c.in !== undefined) return c.in.some((x) => same(x, value));
  if (c.notEquals !== undefined) return !same(c.notEquals, value);
  if (c.equals !== undefined) return same(c.equals, value);
  return true;
}

const fill = (template: string, payload: unknown): string =>
  template.replace(/\{([^}]+)\}/g, (whole, path: string) => {
    const v = path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), payload);
    return v === undefined || v === null ? whole : String(v);
  });

export async function startStandInConsole(now: () => number = Date.now): Promise<StandInConsole> {
  const entries: Entry[] = [];
  const jobs: JobRow[] = [];
  const flows = new Map<string, Step[]>();
  const runs: RunRow[] = [];
  const traces: unknown[] = [];
  const beats: string[] = [];
  const logs: StandInConsole["logs"] = [];
  const queues = new Map<string, { maxAttempts: number; leaseMs: number; backoffMs: number; concurrency: number | null; timeoutMs: number | null }>();
  const queueOf = (name: string) => queues.get(name) ?? { maxAttempts: 3, leaseMs: 30_000, backoffMs: 1_000, concurrency: null, timeoutMs: null };
  const changed = [{ invOp: ["config"] }];
  const toJob = (j: JobRow) => ({ $type: "Job", id: j.id, queue: j.queue, payload: j.payload, result: j.result, state: j.state, attempts: j.attempts, maxAttempts: j.maxAttempts, worker: j.worker, key: j.key, error: j.error, step: j.step, flowRun: j.flowRun, lock: j.lock });
  const held = (id: string, token: string): JobRow => {
    const job = jobs.find((j) => j.id === id);
    if (!job || job.token !== token || job.state !== "running") throw new Error(`job ${id} is not held with this token`);
    return job;
  };
  const finished = (j: JobRow) => j.state === "done" || j.state === "skipped" || (j.state === "dead" && j.onFailure === "continue");

  /** The engine: a waiting job whose dependencies have finished is released — ready, or skipped by its condition. */
  const reconsider = (): void => {
    let moved = true;
    while (moved) {
      moved = false;
      for (const j of jobs.filter((x) => x.state === "waiting")) {
        const deps = j.after.map((id) => jobs.find((x) => x.id === id)!);
        if (!deps.every(finished)) continue;
        const results = Object.fromEntries(deps.map((d) => [d.step ?? d.id, d.result]));
        const failures = Object.fromEntries(deps.filter((d) => d.state === "dead").map((d) => [d.step ?? d.id, d.error]));
        if (j.when && !holds(j.when, results)) {
          j.state = "skipped";
          j.error = `skipped: ${j.when.step}${j.when.path ? "." + j.when.path : ""} did not hold`;
        } else {
          j.state = "ready";
          if (j.payload && typeof j.payload === "object") j.payload = { ...(j.payload as object), results, ...(Object.keys(failures).length ? { failures } : {}) };
        }
        moved = true;
      }
    }
  };
  const blockDependents = (id: string, why: string): void => {
    for (const j of jobs.filter((x) => x.state === "waiting" && x.after.includes(id))) {
      j.state = "dead";
      j.error = why;
      blockDependents(j.id, why);
    }
  };
  const runState = (r: RunRow) => {
    const mine = jobs.filter((j) => j.flowRun === r.id);
    const count = (s: string) => mine.filter((j) => j.state === s).length;
    const dead = count("dead");
    const state = dead ? "failed" : mine.length && count("done") + count("skipped") === mine.length ? "done" : "running";
    return { $type: "FlowRun", id: r.id, name: r.name, key: r.key, state, total: mine.length, done: count("done"), skipped: count("skipped"), dead, running: count("running") };
  };

  const put = (a: { queue: string; payload: unknown; key?: string | null; after?: string[]; lock?: string | null; maxAttempts?: number | null; onFailure?: string | null; when?: Condition | null; step?: string; flowRun?: string }): JobRow => {
    const open = a.key ? jobs.find((j) => j.queue === a.queue && j.key === a.key && !["done", "dead", "skipped"].includes(j.state)) : undefined;
    if (open) return open;
    const job: JobRow = {
      id: crypto.randomUUID(),
      queue: a.queue,
      payload: a.payload,
      result: null,
      state: a.after?.length ? "waiting" : "ready",
      attempts: 0,
      maxAttempts: a.maxAttempts ?? queueOf(a.queue).maxAttempts,
      worker: null,
      key: a.key ?? null,
      error: null,
      token: null,
      leaseUntil: null,
      step: a.step ?? null,
      flowRun: a.flowRun ?? null,
      after: a.after ?? [],
      when: a.when ?? null,
      lock: a.lock ?? null,
      onFailure: a.onFailure === "continue" ? "continue" : "abort",
    };
    jobs.push(job);
    reconsider();
    return job;
  };

  const resolvers: Resolvers = {
    Query: {
      config: ({ app, environment }: { app: string; environment: string }) => entries.filter((e) => e.app === app && e.environment === environment).map((e) => ({ $type: "ConfigEntry", ...e, value: e.secret ? null : e.value })),
      jobs: ({ queue, state, flowRun, limit }: { queue?: string | null; state?: string | null; flowRun?: string | null; limit: number }) =>
        jobs.filter((j) => (!queue || j.queue === queue) && (!state || j.state === state) && (!flowRun || j.flowRun === flowRun)).slice(-limit).reverse().map(toJob),
      flowRuns: ({ name, limit }: { name?: string | null; limit: number }) => runs.filter((r) => !name || r.name === name).slice(-limit).reverse().map(runState),
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
      defineQueue: ({ name, maxAttempts, leaseMs, backoffMs, concurrency, timeoutMs }: { name: string; maxAttempts?: number | null; leaseMs?: number | null; backoffMs?: number | null; concurrency?: number | null; timeoutMs?: number | null }) => {
        const q = { ...queueOf(name), ...(maxAttempts ? { maxAttempts } : {}), ...(leaseMs ? { leaseMs } : {}), ...(backoffMs ? { backoffMs } : {}), ...(concurrency !== undefined ? { concurrency } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
        queues.set(name, q);
        return { $type: "Queue", name, ...q };
      },
      enqueue: (a: { queue: string; payload: unknown; key?: string | null; after: string[]; lock?: string | null; maxAttempts?: number | null; onFailure?: string | null }) => toJob(put(a)),
      claim: ({ queue, worker, leaseMs }: { queue: string; worker: string; leaseMs?: number | null }) => {
        const q = queueOf(queue);
        const lease = leaseMs ?? q.leaseMs;
        const running = jobs.filter((j) => j.queue === queue && j.state === "running" && (j.leaseUntil ?? 0) >= now());
        if (q.concurrency !== null && running.length >= q.concurrency) return null;
        const job = jobs.find(
          (j) =>
            j.queue === queue &&
            (j.state === "ready" || (j.state === "running" && (j.leaseUntil ?? 0) < now())) &&
            (j.lock === null || !jobs.some((r) => r !== j && r.lock === j.lock && r.state === "running" && (r.leaseUntil ?? 0) >= now())),
        );
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
        reconsider();
        return toJob(job);
      },
      failJob: ({ id, token, error, retry }: { id: string; token: string; error: string; retry: boolean }) => {
        const job = held(id, token);
        const dead = !retry || job.attempts >= job.maxAttempts;
        Object.assign(job, { state: dead ? "dead" : "ready", error, token: null, leaseUntil: null });
        if (dead) {
          if (job.onFailure === "continue") reconsider();
          else blockDependents(job.id, `${job.step ?? job.queue} failed: ${error}`);
        }
        return toJob(job);
      },
      defineFlow: ({ name, steps }: { name: string; steps: Step[] }) => {
        flows.set(name, steps);
        return { $type: "Flow", name, steps };
      },
      startFlow: ({ name, payload, key }: { name: string; payload: unknown; key?: string | null }) => {
        const steps = flows.get(name);
        if (!steps) throw new Error(`no flow called ${name}`);
        const open = key ? runs.find((r) => r.name === name && r.key === key && runState(r).state === "running") : undefined;
        if (open) return runState(open);
        const run: RunRow = { id: crypto.randomUUID(), name, key: key ?? null };
        runs.push(run);
        const ids = new Map<string, string>();
        for (const step of steps) {
          const job = put({
            queue: step.queue,
            payload,
            after: (step.after ?? []).map((a) => ids.get(a)!),
            when: step.when ?? null,
            maxAttempts: step.retries ?? null,
            lock: step.lock === undefined ? null : fill(step.lock, payload),
            onFailure: step.onFailure ?? null,
            step: step.name,
            flowRun: run.id,
          });
          ids.set(step.name, job.id);
        }
        return runState(run);
      },
    },
  };

  const server = createRayfoldServer({ schema: SCHEMA, resolvers });
  // whoever reaches the console is an operator, as the console itself has it today; a keyed command needs a caller
  // to scope its idempotency record to, so this is not optional
  const rayfold = createHttpHandler(server, { viewer: () => ({ id: "operator" }) });
  // the OTLP routes beside the Rayfold one, as the console has them: JSON in, 200 out, kept for a test to look at
  const http: Server = createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/otlp/v1/traces" || req.url === "/otlp/v1/logs")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (req.url === "/otlp/v1/traces") traces.push(payload);
        else logs.push(...flattenLogs(payload));
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
    flows,
    runs,
    traces,
    beats,
    logs,
    stop: () => shutdown(server, http, { timeoutMs: 2_000, flushMs: 50 }),
  };
}
