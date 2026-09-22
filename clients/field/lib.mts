/**
 * The field client: a program on a poor connection, talking to the workspace the way a device in a warehouse would.
 *
 * Four things the browser panels never needed. The wire is Rayfold Binary over one WebSocket, so frames are bytes
 * rather than JSON text. Commands made while the server cannot be reached are queued with their idempotency keys and
 * sent in order when it can, so a retry is a replay and never a second run. A command shows its predicted effect at
 * once, and the schema's `@merge` policy says what happens when the server disagrees. And a shape can defer a block,
 * so the part a screen needs first arrives first.
 *
 * The connection itself is a small TCP proxy this program owns, so "offline" is a switch here rather than a cable to
 * pull: the demo and the test cut the line and restore it without touching the service.
 */
import { RayfoldClient, createWebSocketTransport, type QueueStorage, type QueuedCommand } from "@rayfold/client";
import { createServer, connect, type Server, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";

/** A TCP relay between the client and the service, with a switch. Down, it refuses new connections and drops open ones. */
export class Line {
  private server: Server | null = null;
  private readonly open = new Set<Socket>();
  private up = true;
  port = 0;

  constructor(private readonly toHost: string, private readonly toPort: number) {}

  async start(): Promise<number> {
    this.server = createServer((client) => {
      if (!this.up) return void client.destroy();
      const upstream = connect(this.toPort, this.toHost);
      this.open.add(client);
      this.open.add(upstream);
      client.pipe(upstream).pipe(client);
      const done = () => {
        this.open.delete(client);
        this.open.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", done).on("close", done);
      upstream.on("error", done).on("close", done);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  /** The cable, pulled: everything open is dropped and nothing new gets through. */
  cut(): void {
    this.up = false;
    for (const s of this.open) s.destroy();
    this.open.clear();
  }

  restore(): void {
    this.up = true;
  }

  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** The queue on disk, so commands made offline survive the program being closed and opened again. */
export function fileQueue(path: string): QueueStorage {
  return {
    load: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as QueuedCommand[];
      } catch {
        return [];
      }
    },
    save: (queue) => writeFile(path, JSON.stringify(queue, null, 2)),
  };
}

export interface Manifest {
  schemaHash: string;
  extensions: string[];
  schema: NonNullable<Parameters<typeof createWebSocketTransport>[0]["binary"]>;
}

/** The service's manifest: its schema, which the binary codec needs, and what it serves beside the endpoint. */
export async function manifestOf(httpBase: string): Promise<Manifest> {
  const res = await fetch(`${httpBase}/rayfold/manifest`);
  if (!res.ok) throw new Error(`no manifest at ${httpBase}: ${res.status}`);
  return (await res.json()) as Manifest;
}

export interface FieldOptions {
  /** The service, as HTTP: the manifest is read here. */
  httpBase: string;
  /** Where the socket goes, which may be the line above rather than the service itself. */
  wsUrl: string;
  who: string;
  /** Rayfold Binary on the socket, from the manifest's schema. Off sends JSON text on the same socket. */
  binary: boolean;
  queue: QueueStorage;
}

/** A client on the line: binary frames, the offline queue, and the bearer that says who the device acts for. */
export async function fieldClient(o: FieldOptions): Promise<{ client: RayfoldClient; manifest: Manifest }> {
  const manifest = await manifestOf(o.httpBase);
  const url = new URL(o.wsUrl);
  url.searchParams.set("token", o.who);
  const client = new RayfoldClient({
    // a socket handshake carries no Authorization header from a page; a program can, but this one is written the way
    // a device would be: the identity rides on the URL, and the service reads it as it reads a bearer
    transport: createWebSocketTransport({ url: url.toString(), ...(o.binary ? { binary: manifest.schema } : {}) }),
    client: "field/0.1.0",
    offline: { storage: o.queue, drainOnReconnect: false },
  });
  return { client, manifest };
}
