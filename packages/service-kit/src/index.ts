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
  createHttpHandler,
  createRayfoldServer,
  shutdown,
  type RayfoldServer,
  type Resolvers,
  type UploadStore,
} from "@rayfold/server";
import { PgIdempotencyStore, PgRelay, idempotencySchema, pgNotifications, relaySchema } from "@rayfold/postgres";
import pg from "pg";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ServiceOptions {
  /** What this service is called, in the fleet view and in its own logs. */
  name: string;
  /** The service's Rayfold schema, as text. */
  schema: string;
  /** Built from whatever the service needs; `deps` below hands it the pool. */
  resolvers: (deps: Deps) => Resolvers;
  /** The service's own tables. The platform's own are created before this runs. */
  migrate?: (sql: pg.Pool) => Promise<void>;
  /** Turns a request into the viewer the schema's policies see. */
  viewer?: (req: IncomingMessage, deps: Deps) => unknown;
  /** Where uploaded bytes wait to be claimed. Without one the upload route is not served. */
  uploads?: (deps: Deps) => UploadStore;
  /**
   * Anything else this service serves on its own port, tried before Rayfold sees the request. Return true when the
   * request was answered. This is where a service serves bytes, a webhook, or anything that is not a batch.
   */
  routes?: (req: IncomingMessage, res: ServerResponse, deps: Deps) => boolean;
  /**
   * Runs once the server exists and before the port opens. This is where a service reacts to the rest of the fleet:
   * `server.events.on("DocumentChanged", ...)` hears an event raised by any service on the relay, and
   * `server.changes.publish(...)` makes the live queries here re-run because of it.
   */
  onStart?: (server: RayfoldServer, deps: Deps) => void | Promise<void>;
}

/** What the platform hands a service. */
export interface Deps {
  sql: pg.Pool;
  /** Signs and verifies capability tokens. Every service in the fleet shares the secret, so a token minted by one is honoured by the next. */
  caps: Capabilities;
  config: Config;
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
  capabilitySecret: string;
  /**
   * Browser origins allowed to make a request that changes data. A page on another origin is refused (spec 12 §2.1),
   * which is what stops a foreign site from acting as a signed-in user.
   *
   * In production a gateway puts the front ends and the services on one origin and this is empty. In development
   * they are on different ports, so each front end's origin is named here.
   */
  allowedOrigins: string[];
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
    capabilitySecret: required("CAPABILITY_SECRET"),
    allowedOrigins: (process.env["ALLOWED_ORIGINS"] ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/** Reads a file next to the caller, for a service loading its own `.rayfold`. */
export function schemaAt(url: URL | string): string {
  return readFileSync(url, "utf8");
}

export { FileUploadStore, type FileUploadOptions } from "./upload-file.ts";
export { SESSION_COOKIE, TEAM, membersSeed, personOf, type Person } from "./team.ts";

/**
 * Answers a browser's preflight for the upload route with the upload headers allowed.
 *
 * @rayfold/server 0.2.0 leaves `Rayfold-Upload-Name` and `Rayfold-Upload-Type` out of its allow list, so a page on
 * another origin can never upload: the browser refuses the request before the server sees a byte. Fixed upstream
 * for 0.2.1 with a test; this answers the one preflight itself until that ships, and goes away then.
 */
function uploadPreflight(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  if (req.method !== "OPTIONS" || !(req.url ?? "").split("?")[0]?.endsWith("/rayfold/uploads")) return false;
  const origin = req.headers.origin;
  if (!origin || !(allowedOrigins.includes(origin) || allowedOrigins.includes("*"))) return false; // Rayfold's own answer applies
  res.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, Rayfold-Client, Rayfold-Upload-Name, Rayfold-Upload-Type",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  res.end();
  return true;
}

export async function startService(opts: ServiceOptions): Promise<RunningService> {
  const config = configFrom(opts.name);
  const sql = new pg.Pool({ connectionString: config.databaseUrl });
  const caps = new Capabilities({ secret: config.capabilitySecret });
  const deps: Deps = { sql, caps, config };

  // the platform's tables first: both are safe to run from every instance at once
  await sql.query(idempotencySchema());
  await sql.query(relaySchema());
  await opts.migrate?.(sql);

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
    identity: { name: config.name, version: config.version, instance: config.instance },
    onRelayError: (e) => console.error(`[${config.name}] relay refused a message:`, e),
  });

  await opts.onStart?.(server, deps);

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

  // the service's own routes first, then Rayfold: a service owns its port, and Rayfold is what most of it answers
  const http = createServer((req, res) => {
    if (uploadPreflight(req, res, config.allowedOrigins)) return;
    if (opts.routes?.(req, res, deps)) return;
    void rayfold(req, res).catch((e: unknown) => {
      console.error(`[${config.name}] ${req.method} ${req.url} failed`, e);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(config.port, resolve));

  const stop = async (): Promise<void> => {
    await shutdown(server, http);
    await listener.end();
    await sql.end();
  };

  // a deploy sends SIGTERM and then waits: draining first is what makes a rolling deploy lose nothing
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.log(`[${config.name}] ${signal}: draining`);
      void stop().then(
        () => process.exit(0),
        (e) => {
          console.error(`[${config.name}] shutdown failed`, e);
          process.exit(1);
        },
      );
    });
  }

  console.log(`[${config.name}] ${config.version} (${config.instance}) on :${config.port}`);
  return { server, http, deps, counters, stop };
}
