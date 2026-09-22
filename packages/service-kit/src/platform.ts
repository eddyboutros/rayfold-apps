/**
 * What a service gets from the platform's console, when there is one: configuration it keeps watching, a queue it
 * can put work on and take work from, and somewhere to send its traces.
 *
 * THE CONSOLE IS A SEPARATE, COMMERCIAL PRODUCT. It is the Rayfold Console — the queue, the flows, the live
 * configuration and the traces and logs screens live there, in a private repository, and it is not on sale yet. This
 * repository does not contain it. Everything in this file talks to it over its own Rayfold API; without it (no
 * `CONSOLE_URL`) every service here still starts and serves — the fallback below — but no job is queued, no flow
 * runs, configuration is the defaults, and nothing is traced or logged beyond the process's own output. If you have
 * cloned this repository to try it, expect exactly that until the console is available.
 *
 * All three are the console's own Rayfold API, used through the ordinary client — a service on the platform speaks
 * to the platform the way its own front end speaks to it. Configuration is a live query, so a value changed in the
 * console reaches every instance without a restart; a job is a command, so a worker inherits idempotency and typed
 * errors rather than learning a queue SDK; traces go over OTLP because that is what everything else speaks.
 *
 * Without `CONSOLE_URL` a service runs alone: configuration is its defaults, the queue swallows what is put on it and
 * hands out nothing, and no trace leaves the process. A service must not need the platform to serve.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import type { Instrumentation } from "@rayfold/server";
import { rayfoldTracing } from "@rayfold/otel";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/** A line a service writes: to its own output always, and to the console when there is one. */
export interface Log {
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

type Level = keyof Log;
const SEVERITY: Record<Level, SeverityNumber> = { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR };

/**
 * A log that writes to the process's output, and to an OpenTelemetry logger when given one. A line written while a
 * batch is being served carries that batch's trace id, because the SDK reads the active span: the console shows the
 * line under the request that wrote it.
 */
function makeLog(app: string, otel: Logger | null): Log {
  const write = (level: Level, message: string, attributes: Record<string, unknown> = {}): void => {
    const line = `[${app}] ${message}${Object.keys(attributes).length ? ` ${JSON.stringify(attributes)}` : ""}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    otel?.emit({ severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: message, attributes: attributes as Record<string, string> });
  };
  return {
    debug: (m, a) => write("debug", m, a),
    info: (m, a) => write("info", m, a),
    warn: (m, a) => write("warn", m, a),
    error: (m, a) => write("error", m, a),
  };
}

export interface PlatformOptions {
  /** The console, e.g. `http://console:4600`. Absent means no platform. */
  url?: string | undefined;
  /** This service's name: the `app` its configuration is filed under. */
  app: string;
  environment: string;
  /** Identifies this process among the workers of a queue. */
  instance: string;
  log?: (line: string) => void;
}

export interface Job<P = unknown> {
  id: string;
  payload: P;
  attempts: number;
}

export interface WorkOptions {
  /** How long a claim holds a job; renewed while the handler runs. */
  leaseMs?: number;
  /** How long to wait when the queue is empty before asking again. */
  idleMs?: number;
}

/**
 * What a job checks before it runs, against the result of a step it waited for: `path` is dotted into that step's
 * result; one of the tests applies.
 */
export interface Condition {
  step: string;
  path?: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  exists?: boolean;
}

/** One step of a flow, as the console defines them. */
export interface FlowStep {
  name: string;
  queue: string;
  after?: string[];
  when?: Condition;
  retries?: number;
  timeoutMs?: number;
  priority?: number;
  delayMs?: number;
  /** An exclusive key, with `{path}` filled from the run's payload: two runs about one thing take turns here. */
  lock?: string;
  onFailure?: "abort" | "continue";
}

export interface Platform {
  /** Whether a console is configured at all. */
  readonly connected: boolean;
  readonly config: LiveConfig;
  /** The service's log: its own output, and the console's Logs screen when there is one, tied to the trace. */
  readonly log: Log;
  /** Puts a job on a queue. Answers the job's id, or null when there is no platform to put it on. */
  enqueue(queue: string, payload: unknown, opts?: { key?: string; lock?: string }): Promise<{ id: string } | null>;
  /** Creates a queue with these limits, or leaves it as it is. */
  defineQueue(name: string, opts: { maxAttempts?: number; leaseMs?: number; backoffMs?: number; concurrency?: number; timeoutMs?: number }): Promise<void>;
  /** Defines a flow, or replaces it: the steps, the order, the conditions, the locks. Idempotent; a service does it at start. */
  defineFlow(name: string, steps: FlowStep[]): Promise<void>;
  /** Starts a run of a flow. With a key, a run already going about the same thing is what comes back. Null without a platform. */
  startFlow(name: string, payload: unknown, opts?: { key?: string }): Promise<{ id: string; started: boolean } | null>;
  /**
   * Takes jobs from a queue, one at a time, for as long as the service runs. A handler that returns finishes the
   * job with its result; one that throws fails it, and the queue retries it with backoff up to its limit. Answers a
   * function that stops taking work.
   */
  work<P = unknown>(queue: string, handler: (job: Job<P>) => Promise<unknown>, opts?: WorkOptions): () => void;
  /** Rayfold's tracing hook, exporting to the console; undefined without a platform. */
  readonly instrumentation: Instrumentation | undefined;
  stop(): Promise<void>;
}

export interface LiveConfig {
  /** The value as the console has it now, or undefined. */
  get(key: string): string | undefined;
  /** A number, or the fallback when the key is absent or not a number. */
  number(key: string, fallback: number): number;
  /** Everything currently known, for a log line at boot. */
  snapshot(): Record<string, string>;
  /** Resolves once the first answer has arrived, or at once without a platform. A service reads this before serving. */
  ready(): Promise<void>;
}

const key = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function connectPlatform(opts: PlatformOptions): Platform {
  if (!opts.url) return alone(opts.app, opts.log);

  const base = opts.url.replace(/\/$/, "");
  const client = new RayfoldClient({
    transport: createFetchTransport({ url: `${base}/rayfold` }),
    client: `${opts.app}/${opts.instance}`,
  });

  const resource = resourceFromAttributes({ "service.name": opts.app, "service.instance.id": opts.instance, "deployment.environment.name": opts.environment });

  // ---- logs: the OpenTelemetry logs SDK exporting to the console, beside the process's own output
  const loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${base}/otlp/v1/logs` }) })] });
  const logs = makeLog(opts.app, loggerProvider.getLogger(opts.app));
  const log = opts.log ?? ((line: string) => logs.info(line));

  // ---- configuration: one live query, kept for the life of the process
  let values: Record<string, string> = {};
  let first: (() => void) | null = null;
  const firstAnswer = new Promise<void>((resolve) => (first = resolve));
  const stopConfig = client.live<Array<{ key: string; value: string | null; secret: boolean }>>(
    "config",
    { app: opts.app, environment: opts.environment },
    { shape: "{ key value secret }" },
    (entries) => {
      const next: Record<string, string> = {};
      // a secret's value is not on the wire; a service that needs one asks for it by name
      for (const e of entries) if (e.value !== null) next[e.key] = e.value;
      const changed = Object.keys({ ...values, ...next }).filter((k) => values[k] !== next[k]);
      values = next;
      if (changed.length) log(`configuration: ${changed.map((k) => `${k}=${next[k] ?? "(removed)"}`).join(" ")}`);
      first?.();
    },
    (e, { retrying }) => {
      log(`configuration ${retrying ? "interrupted, reconnecting" : "lost"}: ${e instanceof Error ? e.message : String(e)}`);
      // a console that is down is not a reason to hold the service back from serving with what it has
      first?.();
    },
  );

  const config: LiveConfig = {
    get: (k) => values[k],
    number: (k, fallback) => {
      const n = Number(values[k]);
      return values[k] !== undefined && Number.isFinite(n) ? n : fallback;
    },
    snapshot: () => ({ ...values }),
    ready: () => firstAnswer,
  };

  // ---- traces: the OpenTelemetry SDK exporting to the console's OTLP route, and Rayfold's spans on top of it
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/otlp/v1/traces` }))],
  });
  // registers the context manager and the W3C propagator, which is what carries a caller's traceparent into the
  // batch's spans. the global tracer provider is first-come, so the hook below is handed this provider's tracer
  // explicitly rather than the global one
  provider.register();

  const stops: Array<() => void> = [];
  // every lease being renewed right now: stopping the platform stops the renewals, so a job a stopped worker was
  // holding lapses and is taken over rather than renewed by a process that will never finish it
  const beats = new Set<ReturnType<typeof setInterval>>();

  return {
    connected: true,
    config,
    log: logs,
    instrumentation: rayfoldTracing({ tracer: provider.getTracer("@rayfold/server") }),

    async enqueue(queue, payload, o = {}) {
      const job = await client.command<{ id: string }>("enqueue", { queue, payload, ...(o.key ? { key: o.key } : {}), ...(o.lock ? { lock: o.lock } : {}) }, { shape: "{ id }", key: key() });
      return { id: job.id };
    },

    async defineQueue(name, o) {
      await client.command("defineQueue", { name, ...o }, { shape: "{ name }", key: key() });
    },

    async defineFlow(name, steps) {
      await client.command("defineFlow", { name, steps }, { shape: "{ name }", key: key() });
    },

    async startFlow(name, payload, o = {}) {
      // the run's id is what comes back either way; whether this call started it is told by comparing keys, which
      // the console does for us: a run about the same key that is unfinished is returned, not a new one
      const before = o.key ? await client.query<Array<{ id: string; state: string }>>("flowRuns", { name, limit: 50 }, { shape: "{ id key state }", policy: "network" }).catch(() => []) : [];
      const run = await client.command<{ id: string }>("startFlow", { name, payload, ...(o.key ? { key: o.key } : {}) }, { shape: "{ id }", key: key() });
      return { id: run.id, started: !before.some((r) => r.id === run.id) };
    },

    work(queue, handler, o = {}) {
      const leaseMs = o.leaseMs ?? 30_000;
      const idleMs = o.idleMs ?? 2_000;
      const worker = opts.instance;
      let stopped = false;

      const loop = async () => {
        while (!stopped) {
          let claimed: { job: { id: string; payload: unknown; attempts: number }; token: string } | null;
          try {
            claimed = await client.command("claim", { queue, worker, leaseMs }, { shape: "{ job { id payload attempts } token }", key: key() });
          } catch (e) {
            log(`queue ${queue}: could not claim: ${e instanceof Error ? e.message : String(e)}`);
            await sleep(idleMs);
            continue;
          }
          if (!claimed) {
            await sleep(idleMs);
            continue;
          }
          const { job, token } = claimed;
          // renewed at a third of the lease: a handler that takes longer than the lease keeps its job rather than
          // having it handed to a second worker while it is still running
          const beat = setInterval(() => void client.command("heartbeat", { id: job.id, token, leaseMs }, { shape: "{ id }", key: key() }).catch(() => undefined), leaseMs / 3);
          beats.add(beat);
          try {
            const result = await handler(job as Job<never>);
            await client.command("completeJob", { id: job.id, token, result: result ?? null }, { shape: "{ id }", key: key() });
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            log(`queue ${queue}: job ${job.id} failed: ${error}`);
            await client.command("failJob", { id: job.id, token, error }, { shape: "{ id }", key: key() }).catch(() => undefined);
          } finally {
            clearInterval(beat);
            beats.delete(beat);
          }
        }
      };
      void loop();
      const stop = () => void (stopped = true);
      stops.push(stop);
      return stop;
    },

    async stop() {
      for (const s of stops) s();
      for (const b of beats) clearInterval(b);
      beats.clear();
      stopConfig();
      // flushed, so a line written on the way out still arrives
      await Promise.all([provider.shutdown(), loggerProvider.shutdown()]);
    },
  };
}

/** A service with no console: its defaults, a queue that takes nothing, no traces, a log on its own output. */
function alone(app: string, override?: (line: string) => void): Platform {
  const logs = makeLog(app, null);
  const log = override ?? ((line: string) => logs.info(line));
  let said = false;
  const say = () => {
    if (!said) log("no CONSOLE_URL: running without the platform (defaults, no queue, no traces)");
    said = true;
  };
  return {
    connected: false,
    config: { get: () => undefined, number: (_k, fallback) => fallback, snapshot: () => ({}), ready: () => Promise.resolve() },
    log: logs,
    instrumentation: undefined,
    async enqueue() {
      say();
      return null;
    },
    async defineQueue() {
      say();
    },
    async defineFlow() {
      say();
    },
    async startFlow() {
      say();
      return null;
    },
    work() {
      say();
      return () => undefined;
    },
    async stop() {},
  };
}
