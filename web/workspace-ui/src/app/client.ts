/**
 * This remote's connection to its own service. See documents-ui/src/app/client.ts for why a remote provides its
 * own rather than borrowing the shell's: the panel and the service it reads ship together.
 *
 * This one is a WebSocket. The workspace panels keep several subscriptions open at once — the feed, the issues, the
 * chat stream, the bell's count, its stream — and over plain HTTP each would hold a connection of its own, which a
 * browser caps at six per host and a page shares with everything else it loads. One socket carries all of them:
 * each op is an id on the wire, a live query's re-runs and a stream's items arrive on it as frames, and a cancel is
 * a message rather than a closed connection (spec 04 §5). The session cookie goes with the handshake as it goes
 * with a request, so the service sees the same person either way.
 */
import { RayfoldClient, createWebSocketTransport } from "@rayfold/client";

/**
 * Where the workspace service is: `/api/workspace` on the page's own origin. The gateway forwards it in production and
 * the dev server's proxy does in development, so there is no cross-origin request and no origin to configure.
 * A `<meta name="workspace-base">` overrides it for the rare page that is not behind either.
 */
export function workspaceBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="workspace-base"]');
  return (tag?.content || "/api/workspace").replace(/\/$/, "");
}

/** The socket's address: the base made absolute on the page's origin, with the scheme a socket uses. */
export function workspaceSocket(): string {
  const url = new URL(`${workspaceBase()}/rayfold/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function workspaceClient(): RayfoldClient {
  return new RayfoldClient({
    // no credentials here: the session is a cookie on the page's origin, and the browser sends it with the handshake
    transport: createWebSocketTransport({ url: workspaceSocket() }),
    client: "workspace-ui/0.1.0",
  });
}
