/**
 * This remote's connection to its own service. See documents-ui/src/app/client.ts for why a remote provides its
 * own rather than borrowing the shell's: the page and the service it reads ship together.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

/** Where the catalogue service is: `/api/catalogue` on the page's own origin, through the gateway or the dev proxy. */
export function catalogueBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="catalogue-base"]');
  return (tag?.content || "/api/catalogue").replace(/\/$/, "");
}

/**
 * Where the documents service is, for a file's bytes: the catalogue indexes the text and hands out the document's
 * own path, and the page reaches it under that service's base. The only thing this remote knows about another team's
 * service is where it is mounted.
 */
export function documentsBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="documents-base"]');
  return (tag?.content || "/api/documents").replace(/\/$/, "");
}

export function catalogueClient(): RayfoldClient {
  return new RayfoldClient({
    // no credentials here: the session is a cookie on the page's origin, and the browser sends it on its own
    transport: createFetchTransport({ url: `${catalogueBase()}/rayfold` }),
    client: "catalogue-ui/0.1.0",
  });
}
