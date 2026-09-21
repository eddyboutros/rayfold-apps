import { provideZonelessChangeDetection, type ApplicationConfig } from "@angular/core";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { provideRayfold } from "@rayfold/angular";

/**
 * One client for the page, provided by the shell and used by every remote in it.
 *
 * That is the arrangement worth copying: a remote asks for what it needs through `injectQuery`/`injectLive` and
 * never builds a client, so there is one cache and one connection per page however many teams ship into it.
 */
const client = new RayfoldClient({
  transport: createFetchTransport({
    // the workspace service; a gateway would put this on one origin in production
    url: "http://localhost:4002/rayfold",
    headers: () => ({ authorization: "Bearer ada" }),
  }),
  client: "shell/0.1.0",
});

export const appConfig: ApplicationConfig = {
  providers: [provideZonelessChangeDetection(), provideRayfold(client)],
};
