# Front ends

Each of these is its own npm project with its own lockfile, built and deployed on its own — which is the point of a
micro-frontend arrangement and also what keeps the Angular compiler, pinned to one TypeScript version, away from the
services, which are on another.

| | |
|---|---|
| `shell` | The page, the Rayfold client, and who is signed in. Owns no features. |
| `workspace-ui` | The activity feed. Owned by the team that owns the workspace service. |

```sh
cd web/workspace-ui && npm install && npx ng serve --port 4201   # the remote first
cd web/shell        && npm install && npx ng serve --port 4200
```

## How they fit together

Native Federation. The shell reads `public/federation.manifest.json` at startup, and loads what it needs at runtime:

```ts
const { Feed } = await loadRemoteModule("workspace-ui", "./Feed");
```

The feed is never compiled into the shell. The workspace team ships a new one by deploying their own bundle.

**One client for the page.** The shell provides it with `provideRayfold(client)`; a remote asks for what it needs
through `injectQuery` / `injectLive` and never builds a client of its own. So however many teams ship into a page,
there is one cache and one connection.

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
