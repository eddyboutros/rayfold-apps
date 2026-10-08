/**
 * The platform library every service here is built on.
 *
 * A Rayfold service in a fleet needs the same dozen things wired the same way, and getting one of them wrong is only
 * visible during an incident: the idempotency store has to be shared or a retry that reaches another instance runs
 * the command twice; the relay has to be shared or a live query hears only the instance it is attached to; readiness
 * has to be honest or a rolling deploy sends traffic to a server that is not ready; SIGTERM has to drain or a deploy
 * drops the requests in flight.
 *
 * So it is done once, here, and a service says what it is rather than how to run.
 *
 *   await startService({
 *     name: "documents",
 *     schema,
 *     resolvers: resolvers(deps),
 *     migrate: (sql) => sql.query(SCHEMA_SQL),
 *   });
 */
import { readFileSync } from "node:fs";
import {
  Capabilities,
  MemoryCounters,
  MemoryUsage,
  attachWebSocket,
  createBindingHandler,
  createHttpHandler,
  createMcpHandler,
  createRayfoldServer,
  shutdown,
  type RayfoldServer,
  type Resolvers,
  type UploadStore,
} from "@rayfold/server";
import { explorerHtml } from "@rayfold/explorer";
import { PgIdempotencyStore, PgRelay, idempotencySchema, pgNotifications, relaySchema } from "@rayfold/postgres";
import pg from "pg";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connectPlatform, type Platform } from "./platform.ts";

/** What every service says about itself, whatever serves its port. */
export interface CoreOptions {
  /** What this service is called, in the fleet view and in its own logs. */
  name: string;
  /** The service's Rayfold schema, as text. */
  schema: string;
  /** Built from whatever the service needs; `deps` below hands it the pool. */
  resolvers: (deps: Deps) => Resolvers;
  /** The service's own tables. The platform's own are created before this runs. */
  migrate?: (sql: pg.Pool) => Promise<void>;
  /**
   * The shapes this service's clients send, registered at start. With TRUSTED_SHAPES=1 they are the only shapes the
   * service accepts (spec 02 section 3): a shape it has never seen is refused, whoever sends it.
   */
  shapes?: readonly string[];
  /**
   * Runs once the server exists and before the port opens. This is where a service reacts to the rest of the fleet:
   * `server.events.on("DocumentChanged", ...)` hears an event raised by any service on the relay, and
   * `server.changes.publish(...)` makes the live queries here re-run because of it.
   */
  onStart?: (server: RayfoldServer, deps: Deps) => void | Promise<void>;
}

export interface ServiceOptions extends CoreOptions {
  /** Turns a request into the viewer the schema's policies see. */
  viewer?: (req: IncomingMessage, deps: Deps) => unknown;
  /** Where uploaded bytes wait to be claimed. Without one the upload route is not served. */
  uploads?: (deps: Deps) => UploadStore;
  /**
   * Anything else this service serves on its own port, tried before Rayfold sees the request. Return true when the
   * request was answered. This is where a service serves bytes, a webhook, or anything that is not a batch.
   */
  routes?: (req: IncomingMessage, res: ServerResponse, deps: Deps) => boolean;
}

/** What the platform hands a service. */
export interface Deps {
  sql: pg.Pool;
  /** Signs and verifies capability tokens. Every service in the fleet shares the secret, so a token minted by one is honoured by the next. */
  caps: Capabilities;
  config: Config;
  /** The console, when there is one: live configuration, the queue, and where traces go. See `platform.ts`. */
  platform: Platform;
}

export interface Config {
  name: string;
  port: number;
  databaseUrl: string;
  /** Identifies this process among several of the same service. */
  instance: string;
  version: string;
  /** Gates `GET /rayfold/stats`. Without one the route is not served at all. */
  opsToken: string | undefined;
  /** The most a batch may cost (spec 06 section 5), so one shape cannot ask for every row of every table. */
  budget: number;
  /** Production mode for shapes: only the ones registered at start are served. Off in development. */
  trustedShapes: boolean;
  capabilitySecret: string;
  /**
   * Browser origins allowed to make a request that changes data. A page on another origin is refused (spec 12 §2.1),
   * which is what stops a foreign site from acting as a signed-in user.
   *
   * In production a gateway puts the front ends and the services on one origin and this is empty. In development
   * they are on different ports, so each front end's origin is named here.
   */
  allowedOrigins: string[];
  /** The console's address, for configuration, the queue and traces. Absent: the service runs alone. */
  consoleUrl: string | undefined;
  /** The service token the console minted, presented on every call to it. */
  consoleToken: string | undefined;
  /** Which of this service's configurations to read: `development`, `staging`, `production`. */
  environment: string;
  /** Where other services and workers reach this one, for a URL it hands out to them. */
  selfUrl: string;
  /**
   * Serves the explorer at `/rayfold/explorer`: every operation with its arguments, cost and policies, a request to
   * try, and a dry run for a command that allows one. A page for the people building the fleet, so it is on in
   * development (`npm run dev` sets EXPLORER=1) and absent in production, where nothing sets it.
   */
  explorer: boolean;
}

export interface RunningService {
  server: RayfoldServer;
  http: Server;
  deps: Deps;
  counters: MemoryCounters;
  stop: () => Promise<void>;
}

/** Reads one variable, or fails loudly at boot rather than quietly at the first request that needs it. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; a service cannot start without it`);
  return value;
}

export function configFrom(name: string): Config {
  return {
    name,
    port: Number(process.env["PORT"] ?? 4000),
    databaseUrl: required("DATABASE_URL"),
    // a container's hostname is its identity nearly everywhere; a restart is a new one, which is the point
    instance: process.env["INSTANCE"] ?? process.env["HOSTNAME"] ?? `${name}-${process.pid}`,
    version: process.env["SERVICE_VERSION"] ?? "dev",
    opsToken: process.env["OPS_TOKEN"],
    budget: Number(process.env["COST_BUDGET"] ?? 1000),
    trustedShapes: process.env["TRUSTED_SHAPES"] === "1",
    capabilitySecret: required("CAPABILITY_SECRET"),
    allowedOrigins: (process.env["ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    consoleUrl: process.env["CONSOLE_URL"] || undefined,
    consoleToken: process.env["CONSOLE_TOKEN"] || undefined,
    environment: process.env["APP_ENVIRONMENT"] ?? "development",
    selfUrl: (process.env["SELF_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? 4000}`).replace(/\/$/, ""),
    explorer: process.env["EXPLORER"] === "1",
  };
}

/** Reads a file next to the caller, for a service loading its own `.rayfold`. */
export function schemaAt(url: URL | string): string {
  return readFileSync(url, "utf8");
}

// re-exported so a service keeps one import for what the platform gives it; it is the runtime's own since 0.2.1
export { FileUploadStore, type FileUploadOptions } from "@rayfold/server";
export { SESSION_COOKIE, TEAM, membersSeed, personOf, type Person } from "./team.ts";
export { instant, millis } from "./instant.ts";
export { connectPlatform, type Condition, type FlowStep, type LiveConfig, type Job, type Log, type Platform, type WorkOptions } from "./platform.ts";

/** What a service is once its tables, its relay and its server exist, before anything serves its port. */
export interface Core {
  server: RayfoldServer;
  deps: Deps;
  counters: MemoryCounters;
  /** Closes what `boot` opened, after the port has stopped: the platform's workers, the relay's connection, the pool. */
  release: { platform: () => Promise<void>; connections: () => Promise<void> };
}

/** The advisory lock every service in the fleet, and every instance of one, migrates under. */
export const MIGRATION_LOCK = 0x6b65656c;

/**
 * Runs a migration while no other service is running one. `create table if not exists` is not safe to run from two
 * connections at once: both see no table, and the second is refused with a duplicate key on Postgres's own catalogue
 * (23505) or a duplicate type (42710). On a fresh database every service starts at the same moment and several create
 * the same tables (the platform's two, and `members`, which documents and workspace both seed), so `npm run dev` on
 * an empty database lost a service at random. The lock is a session's, held on one connection of its own for as long
 * as the work takes; the work itself runs on the pool.
 */
export async function migrating(sql: pg.Pool, work: () => Promise<void>): Promise<void> {
  const lock = await sql.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await work();
    } finally {
      await lock.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    lock.release();
  }
}

/**
 * Everything a service needs before it can serve, whatever will serve it: the platform's tables and its own, the
 * shared idempotency store and relay, identity, counters, configuration, and the service's reaction to the fleet.
 * `startService` puts it on Node's http server; `startFetchService` (fetch.ts) behind a `Request` -> `Response` app.
 */
export async function boot(opts: CoreOptions): Promise<Core> {
  const config = configFrom(opts.name);
  const sql = new pg.Pool({ connectionString: config.databaseUrl });
  const caps = new Capabilities({ secret: config.capabilitySecret });
  const platform = connectPlatform({ url: config.consoleUrl, token: config.consoleToken, app: config.name, environment: config.environment, instance: config.instance });
  const deps: Deps = { sql, caps, config, platform };

  // the platform's tables first, then the service's own, one service at a time (see migrating)
  await migrating(sql, async () => {
    await sql.query(idempotencySchema());
    await sql.query(relaySchema());
    await opts.migrate?.(sql);
  });

  // LISTEN holds its connection for as long as it is listening, so the relay gets one of its own rather than
  // taking one out of the pool for the life of the process
  const listener = new pg.Client({ connectionString: config.databaseUrl });
  await listener.connect();
  const relay = new PgRelay(pgNotifications(listener), sql);

  const counters = new MemoryCounters();
  const server = createRayfoldServer({
    schema: opts.schema,
    resolvers: opts.resolvers(deps),
    // shared, so a retry that reaches another instance replays rather than running the command a second time
    idempotency: new PgIdempotencyStore(sql),
    // shared, so a live query on one instance hears a command run on another
    relay,
    counters,
    // which members each client still asks for, served on /stats: what a console's field-usage screen and
    // `rayfold check --unused` read, and what makes removing a field a fact rather than a guess (spec 11)
    usage: new MemoryUsage(),
    identity: { name: config.name, version: config.version, instance: config.instance },
    budget: config.budget,
    trustedShapes: config.trustedShapes,
    // a span per batch, per operation and per loader, exported to the console when there is one
    ...(platform.instrumentation ? { instrumentation: platform.instrumentation } : {}),
    onRelayError: (e) => console.error(`[${config.name}] relay refused a message:`, e),
  });

  // configuration before the port opens: a service serves with its configuration, not with defaults it corrects later
  await platform.config.ready();
  if (platform.connected) console.log(`[${config.name}] configuration from ${config.consoleUrl} (${config.environment}): ${JSON.stringify(platform.config.snapshot())}`);
  await opts.onStart?.(server, deps);

  // the shapes the service's own clients use, known before the first request: what trusted mode serves
  for (const shape of opts.shapes ?? []) server.registerShape(shape);

  return {
    server,
    deps,
    counters,
    release: {
      platform: () => platform.stop(),
      connections: async () => {
        await listener.end();
        await sql.end();
      },
    },
  };
}

/**
 * Stops on the signal a deploy sends, draining first: workers, then the port (live queries end with a retryable
 * error, batches in flight are given time), then the connections. What makes a rolling deploy lose nothing.
 */
export function stopOnSignal(name: string, platform: Platform, stop: () => Promise<void>): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      platform.log.info("draining", { signal });
      void stop().then(
        () => process.exit(0),
        (e) => {
          console.error(`[${name}] shutdown failed`, e);
          process.exit(1);
        },
      );
    });
  }
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const { server, deps, counters, release } = await boot(opts);
  const { sql, config, platform } = deps;

  const uploads = opts.uploads?.(deps);
  const rayfold = createHttpHandler(server, {
    ...(opts.viewer ? { viewer: (req: IncomingMessage) => opts.viewer!(req, deps) } : {}),
    ...(uploads ? { uploads: { store: uploads } } : {}),
    // off unless an ops token is configured, and a server without one answers 404 rather than advertising the route
    ...(config.opsToken ? { stats: { authorize: (req: Request) => req.headers.get("authorization") === `Bearer ${config.opsToken}` } } : {}),
    // the database is what this service cannot serve without, so readiness asks it rather than guessing
    readiness: { db: async () => void (await sql.query("select 1")) },
    allowedOrigins: config.allowedOrigins,
    // the reply that lets a browser on one of those origins read the answer at all
    ...(config.allowedOrigins[0] ? { cors: config.allowedOrigins[0] } : {}),
  });

  // the operations the schema binds to REST-shaped routes (spec 04 section 8): the same contract, for curl,
  // webhooks and anyone who expects resources. served as declared; the gateway's prefix is stripped before here.
  const bindings = createBindingHandler(server, {
    ...(opts.viewer ? { viewer: (req: IncomingMessage) => opts.viewer!(req, deps) } : {}),
    allowedOrigins: config.allowedOrigins,
  });

  // the same schema as MCP tools and resources (spec 10), for an agent: commands are tools with a dry-run twin,
  // queries are tools and resources, and the viewer is whoever the request says, token or session, as everywhere
  const mcp = createMcpHandler(server, {
    path: "/rayfold/mcp",
    ...(opts.viewer ? { viewer: (req: IncomingMessage) => opts.viewer!(req, deps) } : {}),
    allowedOrigins: config.allowedOrigins,
  });

  const explorer = config.explorer ? explorerPage(config.name) : undefined;

  // the service's own routes first, then the bindings, then Rayfold: a service owns its port, and Rayfold is what
  // most of it answers
  const http = createServer((req, res) => {
    if (opts.routes?.(req, res, deps)) return;
    if (explorer && (req.url ?? "").split("?")[0] === EXPLORER_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(explorer);
      return;
    }
    void bindings(req, res)
      .then((answered) => answered || mcp(req, res))
      .then((answered) => (answered === true ? undefined : rayfold(req, res)))
      .catch((e: unknown) => {
      console.error(`[${config.name}] ${req.method} ${req.url} failed`, e);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  // the same schema on a socket, at /rayfold/ws: a browser page with several live queries and streams open holds one
  // connection rather than one per subscription, which is what a browser's per-host limit of six makes necessary.
  // the viewer is read from the handshake the way it is from a request, so a cookie session is the same person here.
  attachWebSocket(http, server, {
    ...(opts.viewer ? { viewer: (req: IncomingMessage) => opts.viewer!(req, deps) } : {}),
    allowedOrigins: config.allowedOrigins,
  });
  await new Promise<void>((resolve) => http.listen(config.port, resolve));

  const stop = async (): Promise<void> => {
    // workers first, so no job is claimed by a process on its way out; then the port, then the connections
    await release.platform();
    await shutdown(server, http);
    await release.connections();
  };

  // a deploy sends SIGTERM and then waits: draining first is what makes a rolling deploy lose nothing
  stopOnSignal(config.name, platform, stop);

  platform.log.info("started", { version: config.version, instance: config.instance, port: config.port, environment: config.environment });
  return { server, http, deps, counters, stop };
}

/** Where a service with EXPLORER=1 serves the explorer, on its own port. */
export const EXPLORER_PATH = "/rayfold/explorer";

/**
 * The explorer's page for one service. It talks to the endpoint the way a browser reaches it, `/api/<service>/rayfold`
 * on the page's own origin, so opened through the shell's dev server or the gateway it is signed in as whoever the
 * session cookie says, and what it shows is what that person may do.
 */
export function explorerPage(name: string): string {
  return explorerHtml({ endpoint: `/api/${name}/rayfold`, title: `Keel: ${name}` });
}
