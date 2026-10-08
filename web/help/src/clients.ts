/**
 * The help centre's two connections: the catalogue, for the pages, and the feedback service, for "was this helpful?".
 *
 * Both are paths on the page's own origin, as everything in Keel is. What differs is how each is read.
 *
 * The pages are public and the same for everyone, so every read of them is a GET a cache can keep: the browser's own,
 * and the gateway's shared one in front of the catalogue. Rayfold serves a query by URL (`GET /rayfold/{op}?a=&s=`)
 * with `Cache-Control` from the schema's `@cache` and an `ETag`, and answers `304` when nothing changed; the transport
 * below is what turns the client's one-query batches into those URLs. It sends no credentials, so an answer is never
 * anyone's in particular, and the schema's rule for HelpPage reads nothing about who is asking: the catalogue marks it
 * `public`, and the gateway keeps one copy for every visitor.
 *
 * The feedback service is the opposite: a visitor's own answer is theirs, and its score is live.
 */
import { RayfoldClient, createFetchTransport, type Transport } from "@rayfold/client";
import { base64url, canonicalJson } from "@rayfold/schema";
import { OP_KINDS as CATALOGUE_OPS } from "./gen/catalogue";

const queriesOf = (kinds: Record<string, string>) => Object.keys(kinds).filter((op) => kinds[op] === "query");

/**
 * One query, as a URL: canonical JSON makes the same arguments the same URL, which is what a cache keys on. Anything
 * else, a batch of several or a command, goes as a POST like any client's.
 */
function cacheable(url: string): Transport {
  const post = createFetchTransport({ url, fetch: (input, init) => fetch(input, { ...init, credentials: "omit" }) });
  return {
    async *send(envelope, opts) {
      const op = envelope.ops.length === 1 ? envelope.ops[0] : undefined;
      if (!opts?.safe || !op) {
        yield* post.send(envelope, opts);
        return;
      }
      const params = new URLSearchParams();
      if (op.args && Object.keys(op.args).length) params.set("a", base64url(canonicalJson(op.args)));
      if (op.shape) params.set("s", op.shape);
      if (op.vars) params.set("v", base64url(canonicalJson(op.vars)));
      const res = await fetch(`${url}/${encodeURIComponent(op.op)}?${params}`, {
        credentials: "omit",
        headers: { accept: "application/rayfold-frames+json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw new Error(`The help centre could not be reached (${res.status})`);
      // the frames of one op, a line each; the server numbered it 1, the client knows it by its own id
      for (const line of (await res.text()).split("\n")) if (line.trim()) yield { ...JSON.parse(line), id: op.id };
    },
  };
}

export function catalogueClient(): RayfoldClient {
  const client = new RayfoldClient({ transport: cacheable("/api/help/rayfold"), client: "help/0.1.0" });
  // a batch goes out as a safe request only when the client knows every op in it is a query
  client.markQueries(queriesOf(CATALOGUE_OPS));
  return client;
}

/**
 * The feedback service: an ordinary client, with the visitor's cookie. Not given the service's schema, which would make
 * it ask for compact frames: a client with a schema sends its queries as safe requests, and Rayfold 0.2.1 buffers a
 * safe request until it ends, which a live query never does (fixed after 0.2.1).
 */
export function feedbackClient(): RayfoldClient {
  return new RayfoldClient({ transport: createFetchTransport({ url: "/api/feedback/rayfold" }), client: "help/0.1.0" });
}
