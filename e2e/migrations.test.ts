import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { MIGRATION_LOCK } from "@apps/service-kit";
import { DATABASE_URL, startTestService, type TestService } from "./harness.ts";
import { until } from "./wait.ts";

/**
 * Services started at the same moment on an empty database, as `npm run dev` and `docker compose up` start them.
 *
 * Postgres refuses two `create table if not exists` of one table run at once, and the services share tables: the
 * platform's two, and `members`, which documents and workspace both seed. Each migrates under one advisory lock, so
 * they take turns. The lock is held here by the test, which is how the turns are seen without timing anything.
 */
const admin = () => {
  const url = new URL(DATABASE_URL);
  url.pathname = "/postgres";
  return url.toString();
};

let fresh: string;
let name: string;
let files: string;
let holder: pg.Client;
const started: TestService[] = [];

/** Whoever is waiting for the migration lock on the fresh database: one row per service waiting its turn. */
async function waiting(): Promise<number> {
  const { rows } = await holder.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted and database = (select oid from pg_database where datname = $2)",
    [MIGRATION_LOCK, name],
  );
  return rows[0].n as number;
}

const table = async (t: string) => (await holder.query("select to_regclass($1) is not null as there", [t])).rows[0].there as boolean;

beforeEach(async () => {
  name = `apps_fresh_${process.pid}_${Date.now()}`;
  const client = new pg.Client({ connectionString: admin() });
  await client.connect();
  await client.query(`create database ${name}`);
  await client.end();
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  fresh = url.toString();
  files = await mkdtemp(join(tmpdir(), "migrations-"));
  holder = new pg.Client({ connectionString: fresh });
  await holder.connect();
});

afterEach(async () => {
  // the last started first: each puts back the environment it found
  for (const svc of started.reverse()) await svc.stop();
  started.length = 0;
  await holder.end();
  const client = new pg.Client({ connectionString: admin() });
  await client.connect();
  await client.query(`drop database if exists ${name} with (force)`);
  await client.end();
  await rm(files, { recursive: true, force: true });
});

// a fresh import each time, as each test starts a service anew: a module is evaluated once per process otherwise
let instance = 0;
const documents = () => startTestService("documents", { DATABASE_URL: fresh, FILES_DIR: join(files, "files"), UPLOADS_DIR: join(files, "uploads") }, ++instance);
const workspace = () => startTestService("workspace", { DATABASE_URL: fresh }, ++instance);

it("a service waits for the migration lock before it creates a table, and starts once it has it", async () => {
  await holder.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
  const starting = documents();
  await until("documents to wait for the lock", async () => ((await waiting()) === 1 ? true : undefined));
  // nothing created while another holds it: not the platform's tables, not its own
  expect([await table("rayfold_idempotency"), await table("rayfold_relay"), await table("members"), await table("documents")]).toEqual([false, false, false, false]);

  await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  started.push(await starting);
  expect([await table("rayfold_idempotency"), await table("rayfold_relay"), await table("members"), await table("documents")]).toEqual([true, true, true, true]);
  expect((await fetch(`${started[0]!.base}/rayfold/ready`)).status).toBe(200);
  // and lets go of it: nobody is left waiting, and the lock is free to take
  expect(await waiting()).toBe(0);
  expect((await holder.query("select pg_try_advisory_lock($1) as got", [MIGRATION_LOCK])).rows[0].got).toBe(true);
  await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
});

it("two services that seed one table, started at the same moment on an empty database, take turns and both start", async () => {
  await holder.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
  const first = documents();
  await until("documents to wait its turn", async () => ((await waiting()) === 1 ? true : undefined));
  const second = workspace();
  await until("workspace to wait its turn too", async () => ((await waiting()) === 2 ? true : undefined));

  await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]);
  started.push(await first, await second);
  for (const svc of started) expect((await fetch(`${svc.base}/rayfold/ready`)).status).toBe(200);
  // one roster between them, seeded twice and the same
  const { rows } = await holder.query("select id, name from members order by id");
  expect(rows).toEqual([
    { id: "u1", name: "Ada Lovelace" },
    { id: "u2", name: "Grace Hopper" },
    { id: "u3", name: "Noor Haddad" },
    { id: "u4", name: "Tomás Ferreira" },
  ]);
});
