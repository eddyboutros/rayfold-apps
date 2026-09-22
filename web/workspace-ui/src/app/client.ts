/**
 * This remote's connection to its own service. See documents-ui/src/app/client.ts for why a remote provides its
 * own rather than borrowing the shell's: the panel and the service it reads ship together.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

/** `<meta name="workspace-origin" content="…">`, or the page's own origin behind a gateway. */
export function workspaceOrigin(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="workspace-origin"]');
  return tag?.content?.replace(/\/$/, "") || window.location.origin;
}

export function workspaceClient(): RayfoldClient {
  return new RayfoldClient({
    transport: createFetchTransport({
      url: `${workspaceOrigin()}/rayfold`,
      headers: () => ({ authorization: "Bearer ada" }),
    }),
    client: "workspace-ui/0.1.0",
  });
}
