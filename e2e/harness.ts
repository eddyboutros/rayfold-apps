/**
 * Starts a service the way the platform starts it, for a test.
 *
 * A service reads its configuration from the environment and owns its process, which is what makes it deployable and
 * what makes it awkward to test. Rather than a second code path for tests, this sets the environment, imports the
 * service's own `main.ts`, and hands back what a test needs to talk to it. What runs under test is what runs in
 * production, including the migration and the shutdown.
 */
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { createServer } from "node:http";
import type { RunningService } from "@apps/service-kit";
import pg from "pg";

/**
 * The tests' own database, not the one a person develops against: every test empties the tables it uses, and a
 * suite that shares a database with a running fleet wipes that fleet's data on every run. Created if it is not
 * there, so `npm test` needs nothing beyond a reachable Postgres.
 */
export const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:rayfold@127.0.0.1:55432/apps_test";

async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  // the maintenance database is where a database is created from
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("select 1 from pg_database where datname = $1", [name]);
    // no `if not exists` for databases in postgres; two suites racing here would both see none and one would fail,
    // which is why the suites in this repository take the database in turns
    if (!rowCount) await client.query(`create database "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end();
  }
}

export interface TestService {
  base: string;
  sql: pg.Pool;
  opsToken: string;
  client: (who: string) => RayfoldClient;
  /** Empties the service's tables between tests, leaving the seed rows. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/** A port nothing is listening on, asked of the operating system rather than guessed. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const OPS_TOKEN = "test-ops-token";

/** The tables each service owns, emptied between tests. The platform's own are added to every list. */
const TABLES: Record<string, string[]> = {
  documents: ["notes", "revisions", "documents"],
  workspace: ["comments", "activity", "issues", "messages", "notifications"],
  // the catalogue's own tables are reference data, seeded at start and kept; the files it indexes are the fleet's
  catalogue: ["files"],
};

/**
 * Starts one service. Pass `replica` to start a second instance of the same one, as a deploy runs several: a fresh
 * query string makes Node load the module again rather than hand back the one already running.
 */
export async function startTestService(name: string, env: Record<string, string> = {}, replica = 0): Promise<TestService> {
  await ensureDatabase(DATABASE_URL);
  const port = await freePort();
  Object.assign(process.env, {
    PORT: String(port),
    DATABASE_URL,
    CAPABILITY_SECRET: "a-test-secret-of-sufficient-length",
    OPS_TOKEN,
    SERVICE_VERSION: "test",
    INSTANCE: `${name}-test`,
    PUBLIC_BASE: "/files",
    // the shell's origin in development, so a test can speak as a browser on it
    ALLOWED_ORIGINS: "http://localhost:4200",
    ...env,
  });

  const base = `http://127.0.0.1:${port}`;
  const specifier = replica ? `../services/${name}/src/main.ts?replica=${replica}` : `../services/${name}/src/main.ts`;
  const service = ((await import(specifier)) as { default: RunningService }).default;
  const sql = new pg.Pool({ connectionString: DATABASE_URL });

  return {
    base,
    sql,
    opsToken: OPS_TOKEN,
    // a client over fetch owns no socket of its own, so there is nothing to close: it is made per test and dropped
    client: (who) => new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${who}` }) }) }),
    reset: async () => {
      // the seed rows stay: they are part of the service, not of any one test
      const tables = TABLES[name] ?? [];
      if (tables.length) await sql.query(`truncate ${tables.join(", ")} restart identity cascade`);
      await sql.query("truncate rayfold_idempotency, rayfold_relay restart identity");
    },
    stop: async () => {
      await service.stop();
      await sql.end();
    },
  };
}
