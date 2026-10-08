/**
 * A WebSocket the page's own transports can open: it speaks Rayfold's socket protocol (one JSON envelope per message
 * up, one JSON frame per message down, `{ cancel: id }` to end an op) and answers from the TestService mounted at the
 * socket's path, as the gateway would route it. Installed before the components load, because each one builds its
 * client as its module is evaluated, and the transport takes the WebSocket it will use then.
 */
import type { RequestEnvelope } from "@rayfold/server/protocol";
import type { TestService } from "./rayfold";

/** The gateway: a socket's path prefix, and the service behind it. */
export const mounted = new Map<string, TestService>();

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly open = new Set<FakeWebSocket>();
  /** Every address a socket was opened to, in order, with the subprotocols it asked for. */
  static readonly opened: Array<{ url: string; protocols: string[] }> = [];

  readyState = FakeWebSocket.CONNECTING;
  private readonly ops = new Map<number, AbortController>();
  private readonly service: TestService | undefined;

  constructor(
    readonly url: string,
    protocols: string | string[] = [],
  ) {
    super();
    FakeWebSocket.opened.push({ url, protocols: typeof protocols === "string" ? [protocols] : protocols });
    const path = new URL(url).pathname;
    this.service = [...mounted].find(([prefix]) => path === `${prefix}/rayfold/ws`)?.[1];
    queueMicrotask(() => {
      if (!this.service) return void this.dispatchEvent(new Event("error"));
      this.readyState = FakeWebSocket.OPEN;
      FakeWebSocket.open.add(this);
      this.dispatchEvent(new Event("open"));
    });
  }

  send(text: string): void {
    const message = JSON.parse(text) as RequestEnvelope | { cancel: number };
    if ("cancel" in message) return void this.ops.get(message.cancel)?.abort();
    const ac = new AbortController();
    for (const op of message.ops) this.ops.set(op.id, ac);
    const service = this.service!;
    void (async () => {
      for await (const frame of service.serve(message, ac.signal)) {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
    })();
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    FakeWebSocket.open.delete(this);
    for (const ac of this.ops.values()) ac.abort();
    this.dispatchEvent(new Event("close"));
  }

  /** Drops every open socket, as a page being closed would. */
  static closeAll(): void {
    for (const ws of [...FakeWebSocket.open]) ws.close();
  }
}
