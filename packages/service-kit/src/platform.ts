/**
 * What a service gets from the platform's console, when there is one: configuration it keeps watching, a queue it
 * can put work on and take work from, and somewhere to send its traces.
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
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

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

export interface Platform {
  /** Whether a console is configured at all. */
  readonly connected: boolean;
  readonly config: LiveConfig;
  /** Puts a job on a queue. Answers the job's id, or null when there is no platform to put it on. */
  enqueue(queue: string, payload: unknown, opts?: { key?: string }): Promise<{ id: string } | null>;
  /** Creates a queue with these limits, or leaves it as it is. */
  defineQueue(name: string, opts: { maxAttempts?: number; leaseMs?: number; backoffMs?: number }): Promise<void>;
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
  const log = opts.log ?? ((line: string) => console.log(`[${opts.app}] ${line}`));
  if (!opts.url) return alone(log);

  const base = opts.url.replace(/\/$/, "");
  const client = new RayfoldClient({
    transport: createFetchTransport({ url: `${base}/rayfold` }),
    client: `${opts.app}/${opts.instance}`,
  });

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
    resource: resourceFromAttributes({ "service.name": opts.app, "service.instance.id": opts.instance, "deployment.environment.name": opts.environment }),
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
    instrumentation: rayfoldTracing({ tracer: provider.getTracer("@rayfold/server") }),

    async enqueue(queue, payload, o = {}) {
      const job = await client.command<{ id: string }>("enqueue", { queue, payload, ...(o.key ? { key: o.key } : {}) }, { shape: "{ id }", key: key() });
      return { id: job.id };
    },

    async defineQueue(name, o) {
      await client.command("defineQueue", { name, ...o }, { shape: "{ name }", key: key() });
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
      await provider.shutdown();
    },
  };
}

/** A service with no console: its defaults, a queue that takes nothing, no traces. Said once in the log. */
function alone(log: (line: string) => void): Platform {
  let said = false;
  const say = () => {
    if (!said) log("no CONSOLE_URL: running without the platform (defaults, no queue, no traces)");
    said = true;
  };
  return {
    connected: false,
    config: { get: () => undefined, number: (_k, fallback) => fallback, snapshot: () => ({}), ready: () => Promise.resolve() },
    instrumentation: undefined,
    async enqueue() {
      say();
      return null;
    },
    async defineQueue() {
      say();
    },
    work() {
      say();
      return () => undefined;
    },
    async stop() {},
  };
}
