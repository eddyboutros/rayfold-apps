/**
 * The service a spec talks to: a real Rayfold server, built from the service's own schema, with resolvers the spec
 * writes. The component's own client code, cache and Angular bindings run unchanged over an in-process transport, so
 * a shape that asks for a field the schema lacks, an argument of the wrong type or a rule the viewer fails is refused
 * here as the service would refuse it.
 *
 * Everything crosses the transport as JSON, as it would cross a socket, and every op is recorded as sent.
 */
import type { ComponentFixture } from "@angular/core/testing";
import { RayfoldClient, createLocalTransport, type Transport } from "@rayfold/client";
import { RayfoldServer, type Resolvers } from "@rayfold/server/core";
import type { Frame, RequestOp } from "@rayfold/server/protocol";

export interface SentOp {
  op: string;
  args: Record<string, unknown>;
  shape?: string;
  live?: boolean;
  ifVersion?: string | number;
}

export class TestService {
  readonly server: RayfoldServer;
  /** Every op any client sent, in order. */
  readonly sent: SentOp[] = [];
  frames = 0;
  private readonly finite = new Set<Promise<void>>();
  private readonly closers = new Set<AbortController>();

  constructor(
    schema: string,
    resolvers: Resolvers,
    public viewer: unknown,
  ) {
    this.server = new RayfoldServer({ schema, resolvers });
  }

  /** A client as a page holds one; `as` speaks for someone else, as a second browser would. */
  client(as?: unknown): RayfoldClient {
    const local = createLocalTransport(this.server, () => (as === undefined ? this.viewer : as));
    const transport: Transport = {
      send: (envelope, opts) => this.carry(local, envelope, opts),
    };
    return new RayfoldClient({ transport });
  }

  /** The ops sent since the last call, without the bookkeeping a spec does not assert on. */
  take(): SentOp[] {
    return this.sent.splice(0, this.sent.length);
  }

  /** Ends every open live query and stream, as closing the page would. */
  close(): void {
    for (const c of this.closers) c.abort();
    this.closers.clear();
  }

  get pending(): number {
    return this.finite.size;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.finite]);
  }

  private carry(local: Transport, envelope: Parameters<Transport["send"]>[0], opts: Parameters<Transport["send"]>[1]): AsyncIterable<Frame> {
    const wire = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    for (const op of wire.ops) this.sent.push(sentOf(op));
    const open = wire.ops.some((op) => op.live || this.server.ir.ops[op.op]?.kind === "stream");
    const ac = new AbortController();
    opts?.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    if (open) this.closers.add(ac);
    const frames = local.send(wire, { ...opts, signal: ac.signal });
    const self = this;
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    if (!open) this.finite.add(finished);
    return (async function* () {
      try {
        for await (const f of frames) {
          self.frames++;
          yield JSON.parse(JSON.stringify(f)) as Frame;
        }
      } finally {
        self.closers.delete(ac);
        self.finite.delete(finished);
        done();
      }
    })();
  }
}

function sentOf(op: RequestOp): SentOp {
  const out: SentOp = { op: op.op, args: op.args ?? {} };
  if (op.shape !== undefined) out.shape = op.shape;
  if (op.live) out.live = true;
  if (op.ifVersion !== undefined) out.ifVersion = op.ifVersion;
  return out;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Runs the page until nothing more happens: every finite request answered, every frame drawn, and a round with no new
 * request and no new frame. Bounded by rounds, not by time, so a page that keeps asking fails here instead of hanging.
 */
export async function settle(fixture: ComponentFixture<unknown>, ...services: TestService[]): Promise<void> {
  let last = -1;
  let quiet = 0;
  for (let round = 0; round < 200; round++) {
    await Promise.all(services.map((s) => s.drain()));
    await macrotask();
    fixture.detectChanges();
    await fixture.whenStable();
    const now = services.reduce((n, s) => n + s.frames + s.sent.length * 1000 + s.pending * 1_000_000, 0);
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 2) return;
  }
  throw new Error("the page did not settle in 200 rounds");
}

/** The text a person reads in an element: its text nodes, a space between each, the template's whitespace collapsed. */
export function text(el: Element | null | undefined): string {
  if (!el) return "";
  const parts: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.nodeValue ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
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
