/**
 * The feedback service: "Was this helpful?" on every page of the public help centre.
 *
 * The one service in the fleet written to the web standard. Its port is a Hono app, and Rayfold is a route in it:
 * `createFetchHandler`, the same endpoint the Node services serve, as a `Request` -> `Response` function. What Hono
 * adds is the part a public page needs and Rayfold does not do: knowing a visitor again. A browser that has never been
 * here gets a cookie naming it, set by middleware on the way out, and from then on that cookie is who it is. Nothing
 * else about the service knows it runs on Hono; moved to Workers, the app would be the same.
 *
 *   GET  /rayfold/manifest      the schema, for a client that wants compact frames
 *   POST /rayfold               batches; a live `score` stays open on the response
 *   GET  /rayfold/ready         asks the database, as every service's readiness does
 */
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { personOf, schemaAt } from "@apps/service-kit";
import { startFetchService } from "@apps/service-kit/fetch";
import { FeedbackStore } from "./store.ts";
import { resolvers, type Viewer } from "./resolvers.ts";
import { VISITOR_COOKIE, visitorOf, visitors } from "./visitor.ts";

function whoIs(request: Request): Viewer | null {
  const visitor = visitors.get(request) ?? visitorOf(request.headers.get("cookie"));
  // the team's session, read the way every service reads it: a signed-in person on the help centre is a member too
  const person = personOf({ headers: { authorization: request.headers.get("authorization") ?? undefined, cookie: request.headers.get("cookie") ?? undefined } });
  if (!visitor && !person) return null;
  return {
    ...(visitor ? { visitor } : {}),
    ...(person ? { member: { id: person.id, name: person.name } } : {}),
  };
}

const service = await startFetchService({
  name: "feedback",
  schema: schemaAt(new URL("./feedback.rayfold", import.meta.url)),
  migrate: async (sql) => new FeedbackStore(sql).migrate(),
  resolvers: (deps) => resolvers({ store: new FeedbackStore(deps.sql) }),
  viewer: (request) => whoIs(request),

  app: (rayfold) => {
    const app = new Hono();

    // a batch is where a visitor is needed; health, readiness and the manifest are asked by machines, which are
    // nobody and get no cookie
    app.use("/rayfold", async (c, next) => {
      const known = visitorOf(c.req.header("cookie") ?? null);
      const visitor = known ?? crypto.randomUUID();
      visitors.set(c.req.raw, visitor);
      await next();
      if (!known) {
        // a year, on the whole origin: the gateway's prefix is outside what this service sees, so the path is /
        setCookie(c, VISITOR_COOKIE, visitor, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 365 * 24 * 3600 });
      }
    });

    app.all("/rayfold", (c) => rayfold(c.req.raw));
    app.all("/rayfold/*", (c) => rayfold(c.req.raw));
    return app;
  },
});

export default service;
