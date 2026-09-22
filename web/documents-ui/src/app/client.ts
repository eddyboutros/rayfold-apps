/**
 * This remote's connection to its own service.
 *
 * A page assembled from several teams' bundles talks to several services, and each remote owns the one it was built
 * against — the documents panel knows the documents service and nothing else. So the client is provided by the
 * component itself rather than by the shell, which means this panel works the same dropped into any page.
 *
 * The origin comes from the document at runtime, so the same bundle serves development, staging and production
 * without being rebuilt.
 *
 * Two transports make one client. Batches, live queries and streams go over a WebSocket, so the panel's three
 * subscriptions hold one connection between them rather than one each against the browser's limit of six per host.
 * Uploads go over HTTP, because that is the route the bytes have (spec 04 §9) and a socket does not carry them.
 * The session is a cookie on the page's origin, and the browser sends it with both.
 */
import { RayfoldClient, createFetchTransport, createWebSocketTransport, type Transport } from "@rayfold/client";

/**
 * Where the documents service is: `/api/documents` on the page's own origin. The gateway forwards it in production and
 * the dev server's proxy does in development, so there is no cross-origin request and no origin to configure.
 * A `<meta name="documents-base">` overrides it for the rare page that is not behind either.
 */
export function documentsBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="documents-base"]');
  return (tag?.content || "/api/documents").replace(/\/$/, "");
}

/** The socket's address: the base made absolute on the page's origin, with the scheme a socket uses. */
function documentsSocket(): string {
  const url = new URL(`${documentsBase()}/rayfold/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function documentsClient(): RayfoldClient {
  const socket = createWebSocketTransport({ url: documentsSocket() });
  const http = createFetchTransport({ url: `${documentsBase()}/rayfold` });
  const transport: Transport = {
    send: (envelope, opts) => socket.send(envelope, opts),
    upload: (body, meta, opts) => http.upload!(body, meta, opts),
  };
  return new RayfoldClient({ transport, client: "documents-ui/0.1.0" });
}
