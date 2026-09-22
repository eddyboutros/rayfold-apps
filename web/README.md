# Front ends

Each of these is its own npm project with its own lockfile, built and deployed on its own — which is the point of a
micro-frontend arrangement and also what keeps the Angular compiler, pinned to one TypeScript version, away from the
services, which are on another.

| | |
|---|---|
| `design/` | Tokens and base styles every app here builds from. Nobody owns the palette; teams own components. |
| `shell` | The page, the project switcher, the theme, and who is signed in. Owns no features and no client. |
| `documents-ui` | Files: upload, share. Owned by the team that owns the documents service. |
| `workspace-ui` | The activity feed. Owned by the team that owns the workspace service. |

```sh
cd web/documents-ui && npm install && npx ng serve --port 4202   # the remotes first
cd web/workspace-ui && npm install && npx ng serve --port 4201
cd web/shell        && npm install && npx ng serve --port 4200
```

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
on the exposed component — and the shell provides none. Where that service is comes from the document at runtime
(`<meta name="documents-origin">`), so one bundle serves development and production; behind a gateway the tags are
empty and every remote uses the page's own origin.

**One design system.** `design/tokens.css` and `design/base.css` are in every app's build. Angular scopes a
component's own styles, so a remote loaded at runtime cannot reach the shell's — but global CSS reaches into every
component's template, which is what lets three bundles put the same button on one page.

**The feed is live.** `injectLive("activity", …)` keeps the query open, and the answer changes when the *documents*
service keeps a file — because the workspace service hears that on the relay. Upload something to `:4001` with the
page open and watch it arrive; nothing polls, and the page never reloads.

## Two things worth knowing

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
warning — the design system went missing that way once.

**A browser on another origin could not upload against `@rayfold/server` 0.2.0.** Its preflight allow list omits
`Rayfold-Upload-Name` and `Rayfold-Upload-Type`, so the browser refuses the request before the server sees it.
Fixed upstream for 0.2.1 with a test; `service-kit` answers that one preflight itself until then.
