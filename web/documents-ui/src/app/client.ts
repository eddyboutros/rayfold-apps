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

/** `<meta name="documents-origin" content="https://documents.example">`, or the page's own origin behind a gateway. */
export function documentsOrigin(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="documents-origin"]');
  return tag?.content?.replace(/\/$/, "") || window.location.origin;
}

export function documentsClient(): RayfoldClient {
  return new RayfoldClient({
    transport: createFetchTransport({
      url: `${documentsOrigin()}/rayfold`,
      // stands in for the session the shell would already hold
      headers: () => ({ authorization: "Bearer ada" }),
    }),
    client: "documents-ui/0.1.0",
  });
}
