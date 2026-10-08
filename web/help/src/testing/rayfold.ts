/**
 * The services a spec talks to: real Rayfold servers, built from the services' own schemas, with resolvers the spec
 * writes. The help centre's own clients (clients.ts) run unchanged: the page's `fetch` is answered by each server's
 * fetch handler, mounted where the gateway mounts the service, so a query the catalogue client turns into a cacheable
 * GET is parsed, checked against the schema and answered with its cache headers exactly as the service would answer
 * it. A shape that asks for a field the schema lacks, an argument of the wrong type or a rule the viewer fails is
 * refused here as the service would refuse it.
 *
 * Every op is recorded as it was sent: its method, so a spec can say a read went out as a GET a cache may keep.
 */
import { act } from "@testing-library/react";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";
import { fromBase64url } from "@rayfold/schema";
import { RayfoldServer, createFetchHandler, type Resolvers } from "@rayfold/server/core";

export interface SentOp {
  op: string;
  args: Record<string, unknown>;
  shape?: string;
  live?: boolean;
  /** How it reached the service: a GET by URL, a POST batch, or an in-process client standing for another browser. */
  via: "GET" | "POST" | "local";
}

/** What a response said about caching, by op, for a spec to assert on. */
export interface Answered {
  op: string;
  status: number;
  cacheControl: string | null;
}

export class TestService {
  readonly server: RayfoldServer;
  /** Every op any client sent, in order. */
  readonly sent: SentOp[] = [];
  readonly answered: Answered[] = [];
  frames = 0;
  /** A status the gateway answers with instead of the service, as nginx does when the service is down. */
  unreachable: number | null = null;
  private readonly finite = new Set<Promise<void>>();
  private readonly closers = new Set<() => void>();
  private readonly handler: (request: Request) => Promise<Response>;

  constructor(
    schema: string,
    resolvers: Resolvers,
    /** Who the page's own requests are from: null for an anonymous one, as the gateway makes every catalogue read. */
    public viewer: unknown,
  ) {
    this.server = new RayfoldServer({ schema, resolvers });
    this.handler = createFetchHandler(this.server, { viewer: () => this.viewer });
  }

  /** A client in another browser: `as` is who it speaks for. */
  client(as: unknown): RayfoldClient {
    const local = createLocalTransport(this.server, () => as);
    return new RayfoldClient({
      transport: {
        send: (envelope, opts) => {
          for (const op of envelope.ops) this.sent.push({ op: op.op, args: op.args ?? {}, ...(op.shape ? { shape: op.shape } : {}), ...(op.live ? { live: true } : {}), via: "local" });
          const ac = new AbortController();
          return this.count(local.send(envelope, { ...opts, signal: ac.signal }), envelope.ops.some((o) => o.live), () => ac.abort(), opts?.signal);
        },
      },
    });
  }

  /** The service's endpoint, as the page's fetch reaches it with the gateway's prefix already stripped. */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, "http://service.test");
    const method = (init.method ?? "GET").toUpperCase();
    let live = false;
    if (method === "GET") {
      const op = decodeURIComponent(url.pathname.replace(/^\/rayfold\//, ""));
      const a = url.searchParams.get("a");
      const s = url.searchParams.get("s");
      this.sent.push({ op, args: a ? (JSON.parse(fromBase64url(a)) as Record<string, unknown>) : {}, ...(s ? { shape: s } : {}), via: "GET" });
    } else {
      const envelope = JSON.parse(String(init.body)) as { ops: Array<{ op: string; args?: Record<string, unknown>; shape?: string; live?: boolean }> };
      for (const op of envelope.ops) this.sent.push({ op: op.op, args: op.args ?? {}, ...(op.shape ? { shape: op.shape } : {}), ...(op.live ? { live: true } : {}), via: "POST" });
      live = envelope.ops.some((o) => o.live);
    }
    if (this.unreachable !== null) return new Response("", { status: this.unreachable });
    // the page's signal is followed by hand: an abort ends the request the service holds, as a browser that goes away
    // ends its connection, and cancels the response the page is reading
    const gone = new AbortController();
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const request = new Request(url, { method, headers, signal: gone.signal, ...(method === "GET" ? {} : { body: String(init.body) }) });
    const res = await this.handler(request);
    const ops = method === "GET" ? [this.sent[this.sent.length - 1]!.op] : (JSON.parse(String(init.body)) as { ops: Array<{ op: string }> }).ops.map((o) => o.op);
    for (const op of ops) this.answered.push({ op, status: res.status, cacheControl: res.headers.get("cache-control") });
    if (!res.body) return res;
    const reader = res.body.getReader();
    const signal = init.signal;
    const body = this.count(
      (async function* () {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      })(),
      live,
      () => {
        gone.abort();
        void reader.cancel().catch(() => undefined);
      },
      signal,
    );
    const iterator = body[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }

  /** The ops sent since the last call. */
  take(): SentOp[] {
    return this.sent.splice(0, this.sent.length);
  }

  /** Ends every open live query, as closing the page would. */
  close(): void {
    for (const c of this.closers) c();
    this.closers.clear();
  }

  /** How many live queries and streams the server holds open now. */
  get open(): number {
    return this.server.changes.size;
  }

  get pending(): number {
    return this.finite.size;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.finite]);
  }

  /** Counts what passes through, and keeps a finite answer pending until its last part has been read. */
  private count<T>(source: AsyncIterable<T>, open: boolean, cancel: () => void, signal?: AbortSignal | null): AsyncIterable<T> {
    const self = this;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    if (!open) this.finite.add(finished);
    // a reader that walks away mid-wait is followed by its signal; closing the page ends every open one
    if (open) this.closers.add(cancel);
    signal?.addEventListener("abort", cancel, { once: true });
    return (async function* () {
      try {
        for await (const value of source) {
          self.frames++;
          yield value;
        }
      } finally {
        self.closers.delete(cancel);
        self.finite.delete(finished);
        done();
      }
    })();
  }
}

/**
 * Puts the services where the page finds them: each path prefix is answered by its service's fetch handler with the
 * prefix stripped, as the gateway does. Anything else the page fetches fails the spec. Returns the stub to install.
 */
export function gateway(routes: Record<string, TestService>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, "http://page.test").pathname + new URL(href, "http://page.test").search;
    for (const [prefix, service] of Object.entries(routes)) {
      if (path.startsWith(`${prefix}/`)) return service.fetch(path.slice(prefix.length), init);
    }
    throw new Error(`the page fetched ${href}, which nothing serves`);
  }) as typeof fetch;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Runs the page until nothing more happens: every finite request answered, every frame drawn, and a round with no new
 * request and no new frame. Bounded by rounds, not by time, so a page that keeps asking fails here instead of hanging.
 */
export async function settle(...services: TestService[]): Promise<void> {
  let last = -1;
  let quiet = 0;
  for (let round = 0; round < 200; round++) {
    await act(async () => {
      await Promise.all(services.map((s) => s.drain()));
      await macrotask();
    });
    const now = services.reduce((n, s) => n + s.frames + s.sent.length * 1000 + s.pending * 1_000_000, 0);
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 2) return;
  }
  throw new Error("the page did not settle in 200 rounds");
}

/** The text a person reads in an element: its text nodes, a space between each, the markup's whitespace collapsed. */
export function text(el: Element | null | undefined): string {
  if (!el) return "";
  const parts: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** A sentence as a person reads it: the element's text as the browser lays it out, whitespace collapsed. */
export function reads(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function all(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((e) => text(e));
}

/** The one element the selector names; fails when there is none or more than one, so a spec cannot click the wrong one. */
export function one<T extends Element = HTMLElement>(root: Element, selector: string): T {
  const found = root.querySelectorAll<T>(selector);
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`);
  return found[0]!;
}

/** The button whose text is exactly this. */
export function button(root: Element, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].filter((b) => text(b) === label);
  if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}: ${all(root, "button").join(" | ")}`);
  return found[0]!;
}

