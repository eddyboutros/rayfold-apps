/**
 * This remote's connection to its own service.
 *
 * A page assembled from several teams' bundles talks to several services, and each remote owns the one it was built
 * against — the documents panel knows the documents service and nothing else. So the client is provided by the
 * component itself rather than by the shell, which means this panel works the same dropped into any page.
 *
 * The origin comes from the document at runtime, so the same bundle serves development, staging and production
 * without being rebuilt.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

/**
 * Where the documents service is: `/api/documents` on the page's own origin. The gateway forwards it in production and
 * the dev server's proxy does in development, so there is no cross-origin request and no origin to configure.
 * A `<meta name="documents-base">` overrides it for the rare page that is not behind either.
 */
export function documentsBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="documents-base"]');
  return (tag?.content || "/api/documents").replace(/\/$/, "");
}

export function documentsClient(): RayfoldClient {
  return new RayfoldClient({
    // no credentials here: the session is a cookie on the page's origin, and the browser sends it on its own —
    // to the batch, to the upload, and to a file link opened in a new tab
    transport: createFetchTransport({ url: `${documentsBase()}/rayfold` }),
    client: "documents-ui/0.1.0",
  });
}
