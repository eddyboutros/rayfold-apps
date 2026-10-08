# Front ends

Each of these is its own npm project with its own lockfile, built and deployed on its own — which is the point of a
micro-frontend arrangement and also what keeps the Angular compiler, pinned to one TypeScript version, away from the
services, which are on another.

| | |
|---|---|
| `design/` | Tokens and base styles every app here builds from. Nobody owns the palette; teams own components. |
| `shell` | The page, the project switcher, the theme, sign-in and the session. Owns no features and no client. |
| `documents-ui` | Files: upload, preview, file in folders, tag, remark on, keep revisions, share, ask for a sign-off; and the page a share link opens for someone with no account. Owned by the team that owns the documents service. Its sign-offs tab talks to the approvals service with a second client of its own: a document's sign-offs are a fact about the document, and the person looking at it is here. |
| `workspace-ui` | Issues with their detail (priority, labels, due day, description), hand-overs, conversations, the activity feed, the project chat, the bell with each person's notifications, and the People page. Owned by the team that owns the workspace service. |
| `catalogue-ui` | The catalogue: one search over products, people and articles, a catalogue to leaf through, a page for each product and person, and an article's history with restore. An article is published to the help centre from its page, and what the help centre's readers said about it is there too, from the feedback service, with a second client. A whole page, not a panel. |
| `help` | The public help centre, for customers: the published articles and "was this page helpful?". Another team's, in **React** on Vite, served at `/help/` on its own and linked from the rail, not loaded into the shell. See below. |

```sh
npm run web          # from the repository root: installs each project the first time, then serves all five
```

Or one at a time, remotes first, which is what that does:

```sh
cd web/documents-ui && npm install && npx ng serve --port 4202
cd web/workspace-ui && npm install && npx ng serve --port 4201
cd web/catalogue-ui && npm install && npx ng serve --port 4203
cd web/help         && npm install && npm start      # Vite, on :4204, at /help/
cd web/shell        && npm install && npx ng serve --port 4200
```

They proxy `/api/<service>` to the services `npm run dev` starts (see the root README), so the page has one origin
in development as it does behind the gateway. A remote opened on its own port shows its own panels, against the
services its proxy names.

Each has its own tests, run in its own directory:

```sh
npm test -- --watch=false        # ng test (Vitest) in an Angular app; tsc, then vitest in jsdom, in web/help
```

A spec drives the component as a person would, and the component's own client, cache and bindings talk to a real
Rayfold server built from the service's own schema, in process, with resolvers the spec writes
(`src/testing/rayfold.ts`). A shape asking for a field the schema lacks, an argument of the wrong type or a rule the
viewer fails is refused there as the service would refuse it. No service and no database is involved. The shell,
which has no client, tests sign-in, the session, the rail and the settings. CI runs every project's tests after its
build.

The product is called Keel. Nothing in it says Rayfold: a customer sees documents, a feed, and a page that stays
current — the protocol is what makes that ordinary.

## How they fit together

Native Federation. The shell reads `public/federation.manifest.json` at startup, and loads what it needs at runtime:

```ts
const { Feed } = await loadRemoteModule("workspace-ui", "./Feed");
```

The feed is never compiled into the shell. The workspace team ships a new one by deploying their own bundle.

**Each remote owns its connection.** A page assembled from several teams' work talks to several services, so a
remote provides the client for the service it was built against — `providers: [provideRayfold(documentsClient())]`
on the exposed component — and the shell provides none. A service is a path on the page's own origin,
`/api/documents`, in development and production alike: the gateway forwards it in one, `proxy.conf.json` in the
other. No bundle knows a host, and nothing a browser does is cross-origin.

**The shell does the page; the remotes do the work.** The shell owns the session, the project switcher, the theme,
the settings page, the guide and the command palette (Ctrl K, or `/`), and none of the features. Even the palette's
"do" entries come from a remote: the workspace team's `./Quick` is loaded into it with the typed text as its input,
and it answers with a DOM event that bubbles up to the palette, which is the one thing a component can say to a page
it knows nothing about. Its "new issue for me" is three commands in one batch, the second and third naming the
first's result with `$ref` before it exists.

**A remote with many subscriptions holds one socket.** The workspace panels keep the feed, the issues, the chat
stream, the bell's count and its stream open at once. Over plain HTTP each is a connection, and a browser allows six
per host — shared with everything else the page loads — so the sixth subscription stalled the page. The workspace
client is `createWebSocketTransport` on `/api/workspace/rayfold/ws` instead: every op is an id on one socket, a live
query's re-runs and a stream's items arrive as frames, and a cancel is a message rather than a closed connection.
The session cookie goes with the handshake as it goes with a request. The documents client stays on HTTP because it
uploads, which the socket does not carry.

**No bundle handles a credential.** The shell's sign-in sets a session cookie on the page's origin and the browser
sends it with every same-origin request — the batch, the upload, a file link opened in a new tab. A remote's client
has no headers to add. Signing out clears the cookie and takes the panels off the page, so their live queries end
with them and nothing stays open in the old name.

**Deployed, each front end is its own container.** `web/Dockerfile` builds any of them from its own lockfile
(`--build-arg APP=…`) and serves the result with nginx; a remote is built with `/remotes/<app>/` as its base href,
so the chunks its `remoteEntry.json` names resolve there wherever the page that loads it lives.

**One design system.** `design/tokens.css` and `design/base.css` are in every app's build. Angular scopes a
component's own styles, so a remote loaded at runtime cannot reach the shell's — but global CSS reaches into every
component's template, which is what lets three bundles put the same button on one page.

**The feed is live.** `injectLive("activity", …)` keeps the query open, and the answer changes when the *documents*
service keeps a file — because the workspace service hears that on the relay. Upload something to `:4001` with the
page open and watch it arrive; nothing polls, and the page never reloads.

## Things worth knowing

**`input.required` and `injectQuery`/`injectLive` do not mix.** The query is in flight the moment it is injected,
which is the behaviour you want, and a required input is not readable that early — it throws `NG0950` during field
initialisation. Give the input a default and let `enabled` wait for the real value:

```ts
readonly projectId = input<string>("");
readonly feed = injectLive("activity", () => ({ projectId: this.projectId() }), {
  enabled: () => this.projectId() !== "",
});
```

**`ng add` puts the federation plugin in `dependencies`.** It is a build plugin, and leaving it there drags
`webpack-dev-server` into a production audit. It belongs in `devDependencies`; the build is unaffected.

**Native Federation's `build` target is a wrapper.** It delegates to the `esbuild` target, and only that one's
`styles` list counts. Editing `architect.build.options.styles` produces a build with no stylesheet at all and no
warning — the design system went missing that way once. `ng test` needs the same: each app's `test` target names
`<app>:esbuild:development` as its `buildTarget`, and `tsconfig.spec.json`, rather than the wrapper.

**A browser on another origin could not upload against `@rayfold/server` 0.2.0.** Its preflight allow list omitted
`Rayfold-Upload-Name` and `Rayfold-Upload-Type`, so the browser refused the request before the server saw it.
Fixed upstream in 0.2.1 with a test; `service-kit` answered that one preflight itself until the fleet moved to it.

## The help centre

`web/help` is what a customer reads, so it is built differently from the rest on purpose, and by a team that chose
React. It uses `@rayfold/react` (`useQuery`, `useLive`, `useCommand`) over the same client every Angular remote uses.

- **Every read of a page is a cacheable GET.** The client's transport (`src/clients.ts`) turns a one-query batch into
  `GET /api/help/rayfold/<op>?a=<canonical args>&s=<shape>` and sends no credentials. The catalogue answers with
  `Cache-Control: public, max-age=60, stale-while-revalidate=600` and an `ETag`, because `HelpPage`'s read rule reads
  nothing about who is asking; the browser revalidates with `If-None-Match` and gets `304`, and the gateway keeps one
  copy for every visitor (`infra/gateway/nginx.conf`, `/api/help/`). The dev server strips the cookie the same way.
- **"Was this page helpful?"** talks to the feedback service with a second client, provided around that one
  component. The score is a live query; the visitor's own answer is the `ratings` list, which for a visitor holds
  only theirs because the service's read rule is in its SQL. A visitor is known again by a cookie the service sets.
- **Its types are generated.** `src/gen/` is `rayfold gen ts` of the catalogue's and the feedback service's schemas
  (`npm run schema:types` at the root); CI fails when a schema changed and they did not.
- **It builds with `npm run build`** (tsc, then Vite) to `dist/help/browser`, which is where `web/Dockerfile` takes
  every front end's build from.
- **Its dev server reads two addresses.** `CATALOGUE_URL` (default `http://localhost:4003`) and `FEEDBACK_URL`
  (default `http://localhost:4005`). `npm run mock -- catalogue` at the root, then `CATALOGUE_URL=http://localhost:4503
  npm start` here, builds the pages against made-up data with no database.
- **Its tests are `npm test`**: `src/pages.spec.tsx` and `src/Feedback.spec.tsx`, with Testing Library in jsdom.
  The page's own `fetch` is answered by the services' fetch handlers, mounted where the gateway mounts them, so a
  spec can say that a read went out as a GET a cache may keep, with the headers the catalogue would answer it with.

