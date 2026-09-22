/**
 * An agent on the workspace: a program acting for a person, through MCP, with a token that allows it three things.
 *
 * The workspace mints the token (`mintAgentToken`): the same person, narrowed to the operations named, marked as an
 * agent's so it cannot mint another. The MCP bridge (spec 10) is the same schema as tools: every command is a tool
 * and has a `.simulate` twin that runs without committing, every query is a tool and, when its arguments are all
 * optional, a resource. What the token does not name, the bridge refuses, whatever the tool call asks.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

export interface AgentToken {
  token: string;
  expiresAt: number;
  ops: string[];
}

/** A token for a program, minted by the person it acts for. */
export async function mintAgentToken(httpBase: string, who: string, ops: string[], ttlMs = 900_000): Promise<AgentToken> {
  const person = new RayfoldClient({ transport: createFetchTransport({ url: `${httpBase}/rayfold`, headers: () => ({ authorization: `Bearer ${who}` }) }) });
  return person.command<AgentToken>("mintAgentToken", { ops, ttlMs }, { shape: "{ token expiresAt ops }" });
}

export interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** One JSON-RPC call to the bridge, as an MCP client makes it: stateless, one request, one JSON reply. */
export class Mcp {
  private next = 1;

  constructor(
    private readonly httpBase: string,
    private readonly token: string,
  ) {}

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.httpBase}/rayfold/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.next++, method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  tools(): Promise<{ tools: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }> }> {
    return this.call("tools/list");
  }

  resources(): Promise<{ resources: Array<{ uri: string; name: string }> }> {
    return this.call("resources/list");
  }

  read(uri: string): Promise<{ contents: Array<{ uri: string; text?: string }> }> {
    return this.call("resources/read", { uri });
  }

  use(name: string, args: Record<string, unknown>): Promise<McpResult> {
    return this.call<McpResult>("tools/call", { name, arguments: args });
  }
}
