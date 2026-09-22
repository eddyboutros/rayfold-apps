/**
 * Who can sign in, and how a request says who it is from.
 *
 * This stands in for the identity provider a fleet would have — a session cookie set by the gateway after a real
 * login, or a JWT it introspects. Every service reads the same session the same way, so signing in once signs in to
 * all of them, and each service keeps its own copy of the roster in its own `members` table, seeded from here.
 */
import type { IncomingMessage } from "node:http";

export interface Person {
  id: string;
  /** What goes in the session. Lower case, no spaces: it is a login name, not a display name. */
  handle: string;
  name: string;
  email: string;
  title: string;
}

export const TEAM: readonly Person[] = [
  { id: "u1", handle: "ada", name: "Ada Lovelace", email: "ada@keel.example", title: "Engineering lead" },
  { id: "u2", handle: "grace", name: "Grace Hopper", email: "grace@keel.example", title: "Platform" },
  { id: "u3", handle: "noor", name: "Noor Haddad", email: "noor@keel.example", title: "Product" },
  { id: "u4", handle: "tomas", name: "Tomás Ferreira", email: "tomas@keel.example", title: "Legal & compliance" },
];

/** The cookie the shell sets on sign-in. Sent by the browser on its own to every service behind the same origin. */
export const SESSION_COOKIE = "keel_session";

/**
 * The signed-in person behind a request, or nobody. A bearer token names a handle for a program that has no browser;
 * the cookie is what a browser sends. An unknown handle is nobody, not an error: the schema's policies say what
 * nobody may do.
 */
export function personOf(req: Pick<IncomingMessage, "headers">): Person | null {
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const handle = bearer ?? cookie(req.headers.cookie, SESSION_COOKIE);
  return handle ? (TEAM.find((p) => p.handle === handle) ?? null) : null;
}

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** The roster as rows, for a service seeding its `members` table. Names are updated in place when the roster changes. */
export function membersSeed(): string {
  const values = TEAM.map((p) => `('${p.id}', '${p.name.replace(/'/g, "''")}')`).join(", ");
  return `insert into members (id, name) values ${values} on conflict (id) do update set name = excluded.name;`;
}
