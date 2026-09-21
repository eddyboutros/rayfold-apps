# Rayfold apps

A fleet of [Rayfold](https://rayfold.dev) microservices and the front ends that use them, built the way a team with
several services and several apps would build it — not as demos.

Everything here depends on the **published** `@rayfold/*` packages from npm, the same ones anyone installs. Nothing
reaches into a checkout of the protocol, which is the point: if a service compiles here, it compiles for you.

```sh
docker compose up --build        # postgres and every service
npm test                         # each service against a real postgres
```

## What is here

| | |
|---|---|
| `services/documents` | Files: upload, replace, keep every revision, share one with a capability token. |
| `packages/service-kit` | How every service is wired. The interesting file in the repository. |
| `e2e/` | The harness services are started with, and the flows that cross them. |

More services and the front ends follow; the shape below is what they plug into.

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
| `OPS_TOKEN` | Gates `GET /rayfold/stats`. Without it that route is not served at all. |
| `PORT` | Default 4000. |
| `SERVICE_VERSION`, `INSTANCE` | What the service reports as its identity. A container's hostname does for the second. |
