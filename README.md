# Rayfold apps

A fleet of [Rayfold](https://rayfold.dev) microservices and the front ends that use them, built the way a team with
several services and several apps would build it — not as demos.

Everything here depends on the **published** `@rayfold/*` packages from npm, the same ones anyone installs. Nothing
reaches into a checkout of the protocol, which is the point: if a service compiles here, it compiles for you.

```sh
docker compose up --build        # postgres, every service, every front end, and a gateway on http://localhost:8080
DOCUMENTS_URL=http://localhost:8080/api/documents WORKSPACE_URL=http://localhost:8080/api/workspace npm run seed
npm test                         # each service against a real postgres
```

Open http://localhost:8080 and sign in as anyone on the team. Add a file in the Documents panel and watch it appear
on the Activity feed, which is served by a different service, without the page reloading. For development,
`web/README.md` says how to run the front ends on their own dev servers against the same services.

`npm run seed` gives a fresh environment a team's first week of work — files, issues, hand-overs, conversations —
through the same operations the front ends use, so a demo shows what the product does and nothing else. It leaves a
project alone once it has work on it.

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
| `/api/<service>/rayfold` | a service's endpoint (`documents`, `workspace`, `catalogue`); the prefix is stripped, the service sees `/rayfold` |
| `/api/documents/files/` | a document's bytes |

Nothing a browser does is cross-origin, so no service names an allowed origin and no preflight ever happens. Each
path is owned by one team and forwards to the container that team ships: a new front end or a new service is a new
container behind the same path, and nothing else moves. The dev servers answer the same paths through a proxy, so
the bundles are identical in development and production.

## What is here

| | |
|---|---|
| `services/documents` | Files: upload, replace, keep every revision, file in folders, tag, remark on, share one with a capability token. |
| `services/workspace` | Issues with priority, labels, due days and a partial-update command; comments; a project chat and each person's notifications over `stream` operations; the team's workload; and a project feed that carries what the rest of the fleet did. |
| `services/catalogue` | Products, people and articles behind one search: an interface, a union shaped with `...on`, numbered pages, lazy fields, loaded fields read once per page (a product's category, a person's writing and department), and every article's earlier versions. |
| `services/approvals` | **Kotlin on Spring Boot**, the fleet's JVM member: sign-offs asked of one person on one document. The same Postgres, the same relay and idempotency tables, the same session cookie; what it raises reaches the workspace's feed and bell, and a new version kept in the documents service reaches it. Built and tested with `./mvnw verify`. |
| `packages/service-kit` | How every service is wired. The interesting file in the repository. |
| `e2e/` | The harness services are started with, and the flows that cross them. |
| `web/` | Keel: the page, and the panels loaded into it at runtime — one per team. Its guide page, "What this shows", maps every Rayfold feature to where it is on the page and the file that does it. See [web/README.md](web/README.md). |

More services and the front ends follow; the shape below is what they plug into.

## What one service knows about another

Nothing, except the name of an event.

The documents service raises `DocumentChanged` when a file is kept or replaced. The workspace service declares that
event in its own schema without ever raising it, and subscribes:

```ts
server.events.on("DocumentChanged", (payload) => { /* record a line on the project's feed */ });
```

The relay delivers it. No shared table, no polling, no webhook to register — and a `live` query on the workspace's
feed updates because of something that happened in a service on another port with its own database tables.
`e2e/fleet.test.ts` asserts exactly that, and four of its tests fail if that one subscription is removed.

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

## Two more clients

Not everything that talks to the fleet is a browser panel. Two programs under `clients/` show the rest of the
protocol, each narrating what it does; run them against the dev fleet.

- **`npm run field`** is a device on a bad line. It talks to the workspace over one WebSocket in Rayfold Binary,
  asks for an issue with a `@defer` block so the thread arrives after the issue, then cuts its own line (it owns a
  small TCP relay), makes a move anyway, and shows the prediction the schema's `@merge` policy allows while the
  command waits on disk with its idempotency key. When the line is back the queue drains, once. `TRUSTED_SHAPES=1`
  on a service makes it serve only the shapes it registered at start (`services/workspace/src/shapes.ts`), by id;
  the test starts one to prove it.
- **`npm run agent`** is a program acting for a person through MCP. The person mints it a token narrowed to a few
  operations (`mintAgentToken`); the bridge at `/rayfold/mcp` lists every command as a tool with a `.simulate` twin
  and every query as a tool and a resource. The agent dry-runs `createIssue`, then runs it, then is refused what the
  token does not name, including minting a wider token for itself.

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
- **Evolution.** `renameDocument` is `@deprecated` with a sunset and a replacement, `updateDocument`. Each service
  has a `rayfold.lock.json`, and `npm run schema:check` in CI refuses a breaking change before its sunset. After a
  compatible change, `npm run schema:lock` records the new hash.

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

**A URL crosses a service boundary, never bytes.** The documents service keeps files on a volume and hands out
`url`. Nothing else in the fleet learns where the bytes are, which is what lets that become an object store later
without touching another service.

**Capability tokens cross service boundaries too.** Every service shares `CAPABILITY_SECRET`, so a token one service
mints is honoured by the next — scoped to the operations it names and expiring on its own.

**A service is tested the way it is deployed.** The harness sets the environment and imports the service's own
`main.ts`: the real migration, the real routes, the real shutdown, against a real Postgres. There is no second code
path for tests.

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
