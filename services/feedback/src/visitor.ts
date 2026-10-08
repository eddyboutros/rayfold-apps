/**
 * A visitor to the help centre: nobody in particular, known again by a cookie this service hands out the first time.
 */

/** The cookie that makes a visitor the same visitor next time. It names nobody: it is a random id and nothing else. */
export const VISITOR_COOKIE = "keel_visitor";
const VISITOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A visitor met for the first time on this request, before the browser has the cookie to send back. */
export const visitors = new WeakMap<Request, string>();

/** The visitor a request's cookie names, when it names one in the form this service hands out. */
export function visitorOf(cookies: string | null): string | undefined {
  for (const part of (cookies ?? "").split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === VISITOR_COOKIE && value && VISITOR.test(value)) return value;
  }
  return undefined;
}
