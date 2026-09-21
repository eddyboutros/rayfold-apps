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

export const DATABASE_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:rayfold@127.0.0.1:55432/apps";

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

export async function startTestService(name: string, env: Record<string, string> = {}): Promise<TestService> {
  const port = await freePort();
  Object.assign(process.env, {
    PORT: String(port),
    DATABASE_URL,
    CAPABILITY_SECRET: "a-test-secret-of-sufficient-length",
    OPS_TOKEN,
    SERVICE_VERSION: "test",
    INSTANCE: `${name}-test`,
    PUBLIC_BASE: "/files",
    ...env,
  });

  const base = `http://127.0.0.1:${port}`;
  const service = ((await import(`../services/${name}/src/main.ts`)) as { default: RunningService }).default;
  const sql = new pg.Pool({ connectionString: DATABASE_URL });

  return {
    base,
    sql,
    opsToken: OPS_TOKEN,
    // a client over fetch owns no socket of its own, so there is nothing to close: it is made per test and dropped
    client: (who) => new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${who}` }) }) }),
    reset: async () => {
      // the seed rows stay: they are part of the service, not of any one test
      await sql.query("truncate revisions, documents restart identity cascade");
      await sql.query("truncate rayfold_idempotency, rayfold_relay restart identity");
    },
    stop: async () => {
      await service.stop();
      await sql.end();
    },
  };
}
