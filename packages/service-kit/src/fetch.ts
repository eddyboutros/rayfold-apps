/**
 * A service whose port is a `Request` -> `Response` app instead of Node's `req`/`res`.
 *
 * Some teams write to the web standard: Hono, or a handler they could move to Workers, Bun or Deno without touching
 * it. Rayfold's endpoint is the same handler there (`createFetchHandler`; the Node transport is that handler with an
 * adapter in front), so such a service is one of the fleet on the same terms as the others: `boot` gives it the
 * shared idempotency store, the relay, identity, counters, configuration and its tables, and this file only serves
 * the port, drains on SIGTERM, and answers readiness by asking the database.
 *
 * What a fetch app does not get here, because Rayfold 0.2.1 has no fetch form of them: the `@http` REST bindings,
 * MCP, and the WebSocket. Live queries and streams still work, on the response, as they do over HTTP anywhere.
 *
 *   await startFetchService({
 *     name: "feedback",
 *     schema,
 *     resolvers: (deps) => resolvers(deps),
 *     viewer: (request) => whoIs(request),
 *     app: (rayfold) => new Hono().all("/rayfold/*", (c) => rayfold(c.req.raw)),
 *   });
 */
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createFetchHandler, shutdown } from "@rayfold/server";
import { EXPLORER_PATH, boot, explorerPage, stopOnSignal, type CoreOptions, type Deps, type RunningService } from "./index.ts";

/** Anything that answers a request: a Hono app, or a plain `{ fetch }`. */
export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface FetchServiceOptions extends CoreOptions {
  /** Turns a request into the viewer the schema's policies see. */
  viewer?: (request: Request, deps: Deps) => unknown;
  /**
   * The app the port serves, built around Rayfold's own handler. Mount it on `/rayfold` and everything under it:
   * the batches, the manifest, live queries, health and readiness, stats.
   */
  app: (rayfold: (request: Request) => Promise<Response>, deps: Deps) => FetchApp;
}

export async function startFetchService(opts: FetchServiceOptions): Promise<RunningService> {
  const { server, deps, counters, release } = await boot(opts);
  const { sql, config, platform } = deps;

  const rayfold = createFetchHandler(server, {
    ...(opts.viewer ? { viewer: (request: Request) => opts.viewer!(request, deps) } : {}),
    // off unless an ops token is configured, as on every other service
    ...(config.opsToken ? { stats: { authorize: (request: Request) => request.headers.get("authorization") === `Bearer ${config.opsToken}` } } : {}),
    readiness: { db: async () => void (await sql.query("select 1")) },
    allowedOrigins: config.allowedOrigins,
    ...(config.allowedOrigins[0] ? { cors: config.allowedOrigins[0] } : {}),
  });
  const app = opts.app(rayfold, deps);
  const explorer = config.explorer ? explorerPage(config.name) : undefined;

  const fetch = (request: Request): Response | Promise<Response> =>
    explorer && new URL(request.url).pathname === EXPLORER_PATH
      ? new Response(explorer, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
      : app.fetch(request);

  // Hono's adapter turns Node's request into a `Request` and streams the `Response` back, so a live query stays open
  // on it; what it returns is Node's own http server, which is what the drain below is written against
  const http = await new Promise<Server>((resolve) => {
    const s = serve({ fetch, port: config.port }, () => resolve(s as Server));
  });

  const stop = async (): Promise<void> => {
    await release.platform();
    await shutdown(server, http);
    await release.connections();
  };
  stopOnSignal(config.name, platform, stop);

  platform.log.info("started", { version: config.version, instance: config.instance, port: config.port, environment: config.environment, runtime: "fetch" });
  return { server, http, deps, counters, stop };
}
