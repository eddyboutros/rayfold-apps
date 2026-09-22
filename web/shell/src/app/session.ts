/**
 * Who is signed in.
 *
 * The session is a cookie on the page's origin, so every service behind `/api/*` receives it on every request and
 * the remotes never handle it: they make ordinary same-origin calls and the browser does the rest. Signing in here
 * sets it; signing out clears it. Nothing in the bundles knows a token.
 *
 * The screen that sets it stands in for an identity provider this environment does not have. In production the
 * gateway's login sets the same cookie after a real sign-in, and this screen is never shown.
 */
export interface Person {
  handle: string;
  name: string;
  email: string;
  title: string;
}

export const COOKIE = "keel_session";

/** The roster the identity provider would know. Matches the services' own copy, seeded from the same list. */
export const TEAM: readonly Person[] = [
  { handle: "ada", name: "Ada Lovelace", email: "ada@keel.example", title: "Engineering lead" },
  { handle: "grace", name: "Grace Hopper", email: "grace@keel.example", title: "Platform" },
  { handle: "noor", name: "Noor Haddad", email: "noor@keel.example", title: "Product" },
  { handle: "tomas", name: "Tomás Ferreira", email: "tomas@keel.example", title: "Legal & compliance" },
];

export function current(): Person | null {
  const handle = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return handle ? (TEAM.find((p) => p.handle === decodeURIComponent(handle)) ?? null) : null;
}

export function signIn(person: Person): void {
  // a week, renewed on every sign-in; SameSite keeps a page elsewhere from riding on it
  document.cookie = `${COOKIE}=${encodeURIComponent(person.handle)}; path=/; max-age=${7 * 24 * 3600}; samesite=lax`;
}

export function signOut(): void {
  document.cookie = `${COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}
