# Rayfold apps

A fleet of [Rayfold](https://rayfold.dev) microservices and the front ends that use them, built the way a team with
several services and several apps would build it — not as demos.

Everything here depends on the **published** `@rayfold/*` packages from npm, the same ones anyone installs. Nothing
reaches into a checkout of the protocol, which is the point: if a service compiles here, it compiles for you.

## Getting started

You need **Node 22 or newer** and **Docker**. The Kotlin service also needs a **JDK 21 or newer**; without one, run
everything else (`--no-jvm` below). Nothing needs the Rayfold protocol's own repository, and nothing needs the
Rayfold Console — see [The platform's console](#the-platforms-console) for what that one is.

```sh
git clone https://github.com/eddyboutros/rayfold-apps && cd rayfold-apps
npm install
```

Then pick one of the two ways to run it.

### All of it in Docker

The quickest way to see it, and the way it is deployed: Postgres, every service, every front end, and one gateway.

```sh
npm run up                        # docker compose up --build; the first build takes a few minutes
```

Open **http://localhost:8080**. To start with a team's first week of work in it instead of an empty page, in
another terminal:

```sh
DOCUMENTS_URL=http://localhost:8080/api/documents WORKSPACE_URL=http://localhost:8080/api/workspace npm run seed
```

`npm run down` stops it and deletes its data.

### Developing, with each piece on its own

The way to work on it: the services and the front ends run from source and reload as you edit. Three terminals.

```sh
npm run db                        # Postgres in Docker on 127.0.0.1:55432; start it once, it keeps its data
npm run dev                       # the five services: documents :4001, workspace :4002, catalogue :4003, approvals :4004, feedback :4005
npm run web                       # the five front ends; the first run installs them, which takes a few minutes
```

Open **http://localhost:4200** once the shell says it is ready. Then, once, fill it with work:

```sh
npm run seed
```

`npm run dev -- --no-jvm` leaves out the Kotlin service when there is no JDK; the sign-offs tab says it is
unavailable and everything else works. The first `npm run dev` builds that service's jar, which takes a minute.

### What to try

Sign in as anyone on the team; the sign-in page asks no password (see below). Then:

- **Add a file** in Documents and watch it appear on the Activity feed, served by a different service, without the
  page reloading.
- **Open Keel in a second window as someone else** and hand them an issue: their bell rings, their People page moves.
- **Open an issue** to edit it, reply on it, or attach one of the project's documents to it.
- **Ask for a sign-off** on a file: the Kotlin service raises it and the workspace's feed and bell hear it.
- **Open a product** in the Catalogue as Noor, then as anyone else: only the product team sees its margin.
- **Change a project's settings** from its page header; the rail follows.
- **Publish an article to the help centre** from its page in the Catalogue, then open **Help centre** in the rail: the
  customers' site, in React, reading only what is published. Say whether a page helped, and watch the count move on
  the article's page in Keel, where the team reads every answer.
- **What this shows**, in the rail, maps every Rayfold feature to the place on the page that uses it and the file
  that does it. It is the best place to start reading code.

`npm run field`, `npm run agent` and `npm run signoff` are three more clients, run against the dev fleet;
[Three more clients](#three-more-clients) says what each does.

### Tests

```sh
npm run db                        # if it is not running already
npm test                          # every service against a real Postgres, the platform library, and the flows that cross them
cd services/approvals && ./mvnw verify    # the Kotlin service's own tests (mvnw.cmd on Windows)
cd clients/signoff && ./mvnw verify       # the Kotlin client, against the jar the line above built
cd web/<app> && npm test -- --watch=false # one front end's component tests: shell, documents-ui, workspace-ui, catalogue-ui, help
```

`npm test` starts each service from its own `main.ts`; `e2e/migrations.test.ts` starts several at once on an empty
database, as `npm run dev` does. The Kotlin service's tests are `ApprovalsTest` and `MigrationsTest`; the signoff
client's start the service's jar as a process. A front end's tests are `ng test` (Vitest) for the Angular apps and
`vitest` in jsdom for the help centre, each in its own project. The shell's test sign-in, the session, the rail, the keyboard and the settings; in
the four that talk to a service, the component's own client code runs against a real
Rayfold server built from the service's own schema, in process (`src/testing/rayfold.ts`), so a shape or an argument
the service would refuse fails the spec. They need no database and no service running, only the project's own
install, which `npm run web` does the first time.

The tests use their own database, `apps_test`, beside the one `npm run dev` uses, so running them never wipes what
you were looking at. They expect Postgres on 55432, where `npm run db` puts it; with the Docker Compose Postgres
instead (55433), set `TEST_DATABASE_URL=postgres://postgres:rayfold@127.0.0.1:55433/apps_test`.

`npm run schema:check` compares each service's schema with its committed contract (`rayfold.lock.json`) and refuses
a breaking change; `npm run schema:lock` records a deliberate one. `npm run schema:types` regenerates the types the
help centre and the signoff client are compiled against. CI runs all of it and everything above, builds every front
end and every image, and fails when `schema:types` changes a generated file.

### The fleet in a browser

`npm run test:fleet` is every flow a person can take across the fleet, through the real front ends in Chromium,
against the real services, with the CLI clients beside them (`e2e/browser/`, Playwright). It needs Postgres from
`npm run db`, a JDK 21, and Chromium for Playwright, installed once:

```sh
npx playwright install chromium
npm run test:fleet                                   # starts the fleet, runs the specs, stops what it started
npm run test:fleet -- --grep "sign-off"              # anything after -- goes to playwright test
FLEET_URL=http://localhost:8080 npm run test:fleet   # a fleet already running, such as npm run up; starts nothing
```

On its own it creates a database, `apps_fleet_browser`, starts the stand-in console, `npm run dev` and `npm run web`
against it, waits for every service and dev server, and drops the database at the end. It refuses to start when
something already holds the fleet's ports: stop `npm run dev` and `npm run web` first. `FLEET_NO_JVM=1` runs it
without the Kotlin service and skips what needs it; `FLEET_VERBOSE=1` prints every process's output. Against the
gateway, also set `FLEET_MODE=compose`, and `FLEET_DATABASE_URL=postgres://postgres:rayfold@127.0.0.1:55433/apps`
for the checks that read what a service stored. It is not in CI: the first build of five dev servers takes minutes.

## Who is signed in

Four people, seeded into every service from one roster (`packages/service-kit/src/team.ts`). The shell's sign-in
page sets a session cookie on the page's origin; the browser sends it to every service behind `/api/*` on its own,
and to a file link opened in a new tab. No bundle handles a credential and no service is told about the shell. A
program with no browser sends `Authorization: Bearer <handle>` instead, which the tests do.

The sign-in page is where an identity provider would be: it lists the team and asks no password, and says so. The
cookie it sets is the one a real login would set. Everything after that — every policy, every `by` on a feed line —
is real.

## One origin

`infra/gateway/nginx.conf` puts everything behind one host:

| Path | Reaches |
|---|---|
| `/` | the shell |
| `/remotes/<app>/` | a remote's bundle, loaded by the shell at runtime |
| `/api/<service>/rayfold` | a service's endpoint (`documents`, `workspace`, `catalogue`, `approvals`, `feedback`); the prefix is stripped, the service sees `/rayfold` |
| `/api/documents/files/` | a document's bytes |
| `/help/` | the public help centre, another team's site, not a panel of the shell |
| `/api/help/` | the catalogue again, anonymous and cached: the gateway drops the cookie and `Authorization`, takes only `GET`, and keeps what the service marks `public` (`X-Cache-Status` says `HIT` or `MISS`) |

Nothing a browser does is cross-origin, so no service names an allowed origin and no preflight ever happens. Each
path is owned by one team and forwards to the container that team ships: a new front end or a new service is a new
container behind the same path, and nothing else moves. The dev servers answer the same paths through a proxy, so
the bundles are identical in development and production. The shell's dev server sends `/help/` and `/api/help/` to
the help centre's on :4204, which drops the cookie and `Authorization` on the way to the catalogue as the gateway
does, but caches nothing.

## What is here

| | |
|---|---|
| `services/documents` | Files: upload, replace, keep every revision, file in folders, tag, remark on, share one with a capability token. |
| `services/workspace` | Issues with priority, labels, due days and a partial-update command; comments; a project chat and each person's notifications over `stream` operations; the team's workload; and a project feed that carries what the rest of the fleet did. |
| `services/catalogue` | Products, people and articles behind one search: an interface, a union shaped with `...on`, numbered pages, lazy fields, loaded fields read once per page (a product's category, a person's writing and department), and every article's earlier versions. Also the public help centre's pages: the published articles, read by anyone, with the read rule in the SQL and answers a shared cache may keep. |
| `services/approvals` | **Kotlin on Spring Boot**, the fleet's JVM member: sign-offs asked of one person on one document. The same Postgres, the same relay and idempotency tables, the same session cookie; what it raises reaches the workspace's feed and bell, and a new version kept in the documents service reaches it. Built and tested with `./mvnw verify`. |
| `services/feedback` | **Hono on Rayfold's fetch handler**, the support team's: "was this helpful?" on each page of the public help centre, one answer per visitor per page. A visitor is known again by a cookie its middleware sets; who reads which answer is one rule in the schema, pushed into the SQL. |
| `packages/service-kit` | How every service is wired. The interesting file in the repository. `fetch.ts` is the same for a service whose port is a `Request` -> `Response` app. |
| `clients/` | Programs that are not a browser: the field device, the agent, and `signoff` in Kotlin. |
| `e2e/` | The harness services are started with, the flows that cross them, and in `e2e/browser` the whole fleet driven in a browser (`npm run test:fleet`). |
| `web/` | Keel: the page, and the panels loaded into it at runtime — one per team. Its guide page, "What this shows", maps every Rayfold feature to where it is on the page and the file that does it. And `web/help`, the customers' help centre, in React. See [web/README.md](web/README.md). |


## What one service knows about another

Nothing, except the name of an event.

The documents service raises `DocumentChanged` when a file is kept, replaced or renamed; its `revision` says whether
the bytes changed, so the feed tells a rename from a new version. The workspace service declares that event in its
own schema without ever raising it, and subscribes:

```ts
server.events.on("DocumentChanged", (payload) => { /* record a line on the project's feed */ });
```

The relay delivers it. No shared table, no polling, no webhook to register — and a `live` query on the workspace's
feed updates because of something that happened in a service on another port with its own database tables.
`e2e/fleet.test.ts` asserts exactly that, and eight of its tests fail if that one subscription is removed.

The same subscription keeps a link right. An issue's attachment is a document that lives in the documents service;
the workspace keeps only the link, with the name and address it was shown, and when the file is renamed over there
the same `DocumentChanged` renames every pin of it here — the workspace never asks the documents service anything.
The panel that pins one keeps a client to each service, as the sign-offs panel does for the approvals service.

**A reaction runs on every instance, so it has to be written for that.** The event reaches all of them, and each
one has its own connected clients to wake — that part is right. What must not happen once per instance is the
*write*. So a reaction gives the row an id derived from what caused it (`documents:<id>:<version>`) and writes with
`on conflict do nothing`: the instances race, one wins, the feed has one line. The id is what keeps the feed
correct; the clause is what keeps the losing instances quiet instead of raising a duplicate key every time.

This is the kind of thing that only appears with more than one instance running, which is why there is a test that
starts two.

**The runtime is not part of the contract.** The approvals service is Kotlin on Spring Boot, with `rayfold-core`
and `rayfold-jdbc` from Maven Central. It writes the same `rayfold_idempotency` table, so a retry that lands on it
after landing on a TypeScript service replays; it publishes on the same Postgres channel in the same format, so
`ApprovalRequested` is a line on the workspace's feed and a note on someone's bell; and it hears `DocumentChanged`
from the documents service and marks a pending sign-off stale. Its own tests start a second relay to prove both
directions, and the workspace's tests send the JVM's messages by hand with `pg_notify`, so each half is proved
without the other in the room.

## Three more clients

Not everything that talks to the fleet is a browser panel. Three programs under `clients/` show the rest of the
protocol; run them against the dev fleet. `field` and `agent` act for Ada on the workspace at :4002; `WHO=grace`
and `WORKSPACE_URL` change either.

- **`npm run field`** is a device on a bad line. It talks to the workspace over one WebSocket in Rayfold Binary,
  asks for an issue with a `@defer` block so the thread arrives after the issue, then cuts its own line (it owns a
  small TCP relay), makes a move anyway, and shows the prediction the schema's `@merge` policy allows while the
  command waits on disk with its idempotency key. When the line is back the queue drains, once, and the client
  closes its socket (`close()` from `fieldClient`), so the program ends on its own. `TRUSTED_SHAPES=1`
  on a service makes it serve only the shapes it registered at start (`services/workspace/src/shapes.ts`), by id;
  the test starts one to prove it.
- **`npm run agent`** is a program acting for a person through MCP. The person mints it a token narrowed to a few
  operations (`mintAgentToken`); the bridge at `/rayfold/mcp` lists every command as a tool with a `.simulate` twin
  and every query as a tool and a resource. The agent dry-runs `createIssue`, then runs it, then is refused what the
  token does not name, including minting a wider token for itself.
- **`npm run signoff`** is the sign-off queue from a terminal, for the people who work through one every day:
  `KEEL_USER=tomas npm run signoff -- inbox`, `watch`, `approve <id> [note]`, `decline <id> <note>`. Kotlin, on the
  JVM client from Maven Central: HTTP for a read and a decision, one WebSocket for the inbox kept live, and the
  types generated from the approvals schema by `rayfold gen kotlin`, so a renamed field is a compile error. A decision
  keeps its idempotency key, so a retry that never heard the first answer replays it; a declared refusal
  (`AlreadyDecided`, `NotYours`) is an answer, not a stack trace. Its tests start the approvals service's own jar.
  It reaches the service at :4004 (`KEEL_APPROVALS` points it elsewhere) and needs a JDK 21, as that service does.

## The contract

Each service's `.rayfold` file is its API, its REST routes, its OpenAPI document and the rule for changing it.

- **REST routes.** An operation annotated `@http` is served on a method and a path as well as in a batch, with the
  same validation, policies, typed errors and idempotency keys. `GET` answers with an `ETag`, `PATCH` takes
  `If-Match` and answers `412` with the current row when it is stale, `DELETE` with an `Idempotency-Key` replays its
  first answer on a retry, and every error is an RFC 9457 problem. `GET /api/<service>/rayfold/openapi.json` is the
  document generated from the same source.

  ```sh
  curl -H "authorization: Bearer ada" http://localhost:4200/api/documents/documents/<id>
  curl -X PATCH -H "authorization: Bearer ada" -H 'if-match: "1"' -H "content-type: application/json" \
       -d '{"folder":"contracts"}' http://localhost:4200/api/documents/documents/<id>
  ```

- **Named views.** `view Product.card = { ...Product.default category summary }`: what a caller gets with no shape,
  and a name a shape can spread. Removing one is a breaking change.
- **Denials.** `@deny` is evaluated after `@allow`, a second gate: a share may never delete a document, however wide
  its token.
- **Cost budgets.** Every op has a static cost from its shape and page sizes; a batch over `COST_BUDGET` (default
  1000) is refused before it runs.
- **Evolution.** `renameDocument` is `@deprecated` with a sunset and a replacement, `updateDocument`. Each service,
  the Kotlin one included, has a `rayfold.lock.json`, and `npm run schema:check` in CI refuses a breaking change
  before its sunset. After a compatible change, `npm run schema:lock` records the new hash.
- **Read rules in the SQL.** A rule that reads only the row, the viewer and the arguments is handed to the resolver as
  `ctx.policy`, and `@rayfold/postgres` makes it part of the WHERE. `HelpPage` is published or it is not there
  (`createPgStore`, `services/catalogue`); a feedback `Rating` is every member's to read and a visitor's own
  (`compilePolicy`, `services/feedback`). A list then holds only what its reader may see and its total counts only
  that; without it, the runtime, which checks every row anyway, refuses a whole list that holds one row too many.
  `npx rayfold explain services/feedback/src/feedback.rayfold ratings` prints `policy pushed down` per level.
- **A shared cache.** `HelpPage` is `@cache(maxAge: 60s, swr: 10m, scope: public)` and its rule reads nothing about
  who is asking, so a help page read by URL (`GET /rayfold/helpPage?a=...&s=...`) is public, carries an `ETag` and is
  answered `304` while nothing changed. The help centre's client turns its reads into those URLs; the gateway keeps
  one copy for every visitor and revalidates it. The same read by someone signed in is `private`, and never kept.

## Building it

What the people working on the fleet use, beside the product:

- **The explorer.** `npm run dev` sets `EXPLORER=1`, and every service serves the explorer at
  `/rayfold/explorer`: open `http://localhost:4200/api/catalogue/rayfold/explorer` (any service's name) while signed
  in to the shell, and it sends requests as you. The Kotlin service's is on its own port,
  `http://localhost:4004/rayfold/explorer`. Nothing sets it in production, so it is not there.
- **A mock of a service.** `npm run mock -- catalogue` serves the catalogue's schema with made-up data on :4503, with
  no database and no other service; `CATALOGUE_URL=http://localhost:4503 npm start` in `web/help` builds the help
  centre against it. Any service's name works.
- **Generated types.** `npm run schema:types` writes the help centre's TypeScript (`rayfold gen ts`) and the signoff
  client's Kotlin (`rayfold gen kotlin`) from the schemas they read; CI fails when they are stale.
- **A plan before a request.** `npx rayfold explain <schema> <op> --shape "{ ... }"` prints an op's cost, its loader
  calls per level, and which read rules go into the SQL.
- **The editor.** `npx rayfold lsp` is the language server for `.rayfold` files, with the same parser and validator
  the services run; point an editor's LSP client at it (the Rayfold guide, Editors, has VS Code and Neovim set-ups).

## The platform library

`@apps/service-kit` is where the fleet decisions live, because each one is invisible until an incident:

- **A shared idempotency store.** Without it a retry that reaches a different instance runs the command a second
  time. With it, the second instance replays the first one's answer.
- **A shared relay.** Without it a live query hears only the instance it is attached to. With it, a command run on
  one instance reaches a subscription on another.
- **Identity and counters.** Every service reports its name, version and instance, and counts what it did, so a
  console can tell two of them apart and say which is serving last week's schema.
- **Honest readiness.** `GET /rayfold/ready` asks the database rather than assuming, so a rolling deploy does not
  send traffic to a service that cannot answer.
- **A SIGTERM that drains.** Readiness goes false, live queries end with a retryable error, batches in flight are
  given time, and only then does the port close.

A service says what it is; none of that is repeated in it.

## The platform's console

> **The Rayfold Console is a separate, commercial product, in a private repository, and it is not on sale yet.**
> This repository does not contain it. The queues, the flows, the live configuration and the traces and logs
> below all run in it. Without `CONSOLE_URL` every service here still starts and serves — the flow in the table
> further down is simply never started, kept files never become searchable, and configuration is the defaults.
> The tests do not need it: `e2e/stand-in-console.ts` stands in for the operations a service calls.

With `CONSOLE_URL` and `CONSOLE_TOKEN` set, every service is on the platform: it reads its configuration from the console with a **live
query** and applies a change the moment it arrives (the documents service's upload limit is one such value, under
`documents / <environment> / uploads.maxBytes`), it puts work on and takes work from the console's **queue** through
ordinary commands, and it exports a span per batch, operation and loader over **OTLP** so a trace shows how a page
was resolved. Without `CONSOLE_URL` a service runs alone on its defaults; it never needs the platform to serve.

The flow that uses all of it — `document-kept`, defined by the documents service at start and started when a
document is kept, with a capability token that reads that one document for an hour:

| Step | Queue | Worked by | Runs |
|---|---|---|---|
| `extract` | `extract-text` | catalogue | first; fetches the bytes with the token and reads the text |
| `index` | `index-file` | catalogue | after `extract`, **only when** `extract.characters != 0` — a condition between the steps, not an `if` in a worker |
| `notify` | `notify-workspace` | workspace | after `index`, skipped or not: the feed says the file is searchable, or had nothing to index |

`extract` and `index` carry a lock, `doc:{documentId}`, so two versions of one document are never worked on at once,
whichever queue the step is on — the race that would otherwise index the older version last. Nothing is shared
between the services but the platform, and the console's Flows screen shows the run move from queue to queue.
`e2e/fleet.test.ts` drives the whole chain; `e2e/stand-in-console.ts` is the console as a service sees it — the
same flow semantics, in memory — so the tests need only Postgres.

## Conventions

**One database, one schema per service.** Services share a Postgres and never read each other's tables. Two tables
are shared on purpose — `rayfold_idempotency` and `rayfold_relay` — because they are the fleet's, not a service's.

**Migrations take turns.** Postgres refuses two `create table if not exists` of one table run at the same moment, and
`npm run dev` and `docker compose up` start every service at once. So every service, and every instance of one,
migrates under one advisory lock (`MIGRATION_LOCK` in `packages/service-kit`, the same number in the Kotlin
service): on an empty database they wait for each other instead of one of them exiting. `e2e/migrations.test.ts`
and `MigrationsTest` hold the lock themselves to watch the services queue for it.

**An instant is RFC 3339 on the wire.** Every `Instant` a service answers or raises is UTC text, as the schema's
scalar says, in every runtime. The services keep epoch milliseconds in their columns, because a `bigint` orders and
compares for free, and cross between the two only at the store's edge: `instant()` and `millis()` in
`packages/service-kit`, `Instant.ofEpochMilli` in the Kotlin service. The feedback service keeps a `timestamptz` and
answers it with `toISOString()`.

**A URL crosses a service boundary, never bytes.** The documents service keeps files on a volume and hands out
`url`. Nothing else in the fleet learns where the bytes are, which is what lets that become an object store later
without touching another service.

**Capability tokens cross service boundaries too.** Every service shares `CAPABILITY_SECRET`, so a token one service
mints is honoured by the next — scoped to the operations it names and expiring on its own.

**A service is tested the way it is deployed.** The harness sets the environment and imports the service's own
`main.ts`: the real migration, the real routes, the real shutdown, against a real Postgres. There is no second code
path for tests.

## After the next Rayfold release

The fleet is on 0.2.1, from npm and Maven Central, and works around what that release gets wrong. Rayfold's next
release fixes each of these (its changelog, under Unreleased), and the workaround goes when the fleet moves to it:

- **The help centre's feedback client has no schema** (`web/help/src/clients.ts`). With one, it sends a live query
  as a safe request, and 0.2.1 answers a safe request only once it ends, which a live query never does.
- **The catalogue reads help pages with `page`, not `screen`** (`services/catalogue/src/resolvers.ts`). 0.2.1's
  `screen` reads only the columns the shape names, so a list that did not ask for `publishedAt` has every row refused
  by `HelpPage`'s read rule.
- **A workspace panel's live query stops for good** when its socket is refused while no instance is up; the panel
  says so and a reload brings it back. `e2e/browser/09-drain.spec.ts` expects either, by the client's version.

And what the fleet will show once it is there:

- **`@http(name:)`**: a REST route that takes an argument under the name an outside caller sends, such as
  `first-name`, while the schema keeps its own.
- **Tests without a network.** `dev.rayfold:rayfold-test` for the approvals service's tests, `LocalTransport` for
  the signoff client's, and `@rayfold/client/testing` for waiting on a live query's next value in the front ends'
  specs, in place of the helpers each `src/testing/` writes for itself.
- **The JVM server's clock.** The approvals service telling the time by a clock its tests can move, as the
  TypeScript services' resolvers already take a `now`.
- **Angular waits for Rayfold.** `fixture.whenStable()` waits for a query's first answer and a command's run, so the
  Angular specs can wait on it for data.

## When something does not work

| What you see | Why, and what fixes it |
|---|---|
| `npm test` or `npm run dev` fails with `ECONNREFUSED 127.0.0.1:55432` | Postgres is not running. `npm run db`, and start Docker first if that says it is not running. |
| `npm test` stops before running, saying a native binding is missing | npm left a platform binary out of `node_modules`, a known npm bug with optional packages; the message names it. `rm -rf node_modules && npm ci` installs exactly what the committed lockfile lists. |
| After adding a package to a front end, CI's `npm ci` fails with `Missing: @emnapi/... from lock file` | The same npm bug: an `npm install` on one platform wrote a lockfile without another platform's binaries. In that `web/*` project, `rm -rf node_modules package-lock.json && npm install`, and commit the new lockfile. |
| A panel says it is unavailable, with a 404 for a `-dev.js` file | That remote's dev server is serving an old build. Stop `npm run web`, delete the remote's `dist/` folder, start it again. A new file a remote exposes, or a new package it imports, needs the same. |
| The help centre shows a page you just took off | The gateway's shared cache: a help page is fresh for a minute, and served stale for up to ten while it is fetched again. In development nothing caches. |
| The sign-offs tab is unavailable | The Kotlin service is not running: `npm run dev` without `--no-jvm`, which needs a JDK 21. |
| A port is already in use | Something else holds 4001–4005, 4200–4204, 8080 or 55432. Stop it, or change the port in `scripts/dev.mjs`, `scripts/web.mjs` or `docker-compose.yml`. |
| `npm run test:fleet` stops at once: `port 4001 (documents) is already in use` | It starts a fleet of its own and will not test the one you are running. Stop `npm run dev` and `npm run web`, or point it at yours with `FLEET_URL`. |
| `npm run test:fleet` fails with `Executable doesn't exist` | Playwright's Chromium is not installed: `npx playwright install chromium`, once. |
| A service logs `no CONSOLE_URL: running without the platform` | That is normal: the console is a separate product this repository does not include. Files are not made searchable and there are no queues, traces or live configuration; everything else works. |

## Configuration

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres. Required. |
| `CAPABILITY_SECRET` | Signs capability tokens. Shared by the fleet. Required. |
| `ALLOWED_ORIGINS` | Browser origins allowed to change data, comma separated. Empty here: the gateway and the dev proxies put everything on one origin. For a page that is behind neither. |
| `PUBLIC_BASE` | What a document's `url` starts with; `/files`, reached as `/api/documents/files/` through the gateway. |
| `OPS_TOKEN` | Gates `GET /rayfold/stats`. Without it that route is not served at all. |
| `PORT` | Default 4000. |
| `SERVICE_VERSION`, `INSTANCE` | What the service reports as its identity. A container's hostname does for the second. |
| `CONSOLE_URL` | The Rayfold Console: configuration, queue, traces. Absent: the service runs alone. |
| `CONSOLE_TOKEN` | A `service` token the console minted for this service, on its Access screen. The console refuses a caller without one, so a URL without a token also runs alone, and says so at start. |
| `APP_ENVIRONMENT` | Which configuration to read from the console. Default `development`; `production` in compose. |
| `SELF_URL` | Where a worker reaches this service, for a URL it hands out in a job. Default `http://127.0.0.1:$PORT`. |
| `EXPLORER` | `1` serves the explorer at `/rayfold/explorer`. Set by `npm run dev`; absent in production. |
| `COST_BUDGET` | The most a batch may cost before it is refused. Default 1000. |
| `TRUSTED_SHAPES` | `1` serves only the shapes a service registered at start. |
| `FILES_DIR`, `UPLOADS_DIR` | The documents service's volume: kept files, and uploads in progress. `npm run dev` puts both under the temp directory. |
