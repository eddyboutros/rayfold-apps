/**
 * This remote's connection to its own service. See documents-ui/src/app/client.ts for why a remote provides its
 * own rather than borrowing the shell's: the panel and the service it reads ship together.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

/**
 * Where the workspace service is: `/api/workspace` on the page's own origin. The gateway forwards it in production and
 * the dev server's proxy does in development, so there is no cross-origin request and no origin to configure.
 * A `<meta name="workspace-base">` overrides it for the rare page that is not behind either.
 */
export function workspaceBase(): string {
  const tag = document.querySelector<HTMLMetaElement>('meta[name="workspace-base"]');
  return (tag?.content || "/api/workspace").replace(/\/$/, "");
}

export function workspaceClient(): RayfoldClient {
  return new RayfoldClient({
    // no credentials here: the session is a cookie on the page's origin, and the browser sends it on its own
    transport: createFetchTransport({ url: `${workspaceBase()}/rayfold` }),
    client: "workspace-ui/0.1.0",
  });
}
