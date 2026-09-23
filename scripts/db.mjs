#!/usr/bin/env node
/**
 * A Postgres for development and for the tests, in Docker, on port 55432.
 *
 *   npm run db          # start it (creates the container the first time)
 *   npm run db -- stop  # stop it; the data stays in its volume
 *
 * The fleet you run with `npm run dev` uses the `apps` database in it; `npm test` creates and uses `apps_test` beside
 * it, so running the tests never wipes what you were looking at. `docker compose up` brings its own Postgres on
 * 55433 instead, so the two never collide.
 */
import { execFileSync, spawnSync } from "node:child_process";

const NAME = "rayfold-apps-pg";
const PORT = process.env["POSTGRES_PORT"] ?? "55432";

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

if (docker("version", "--format", "{{.Server.Version}}").status !== 0) {
  console.error("Docker is not running. Start Docker Desktop (or the docker daemon), then run this again.");
  process.exit(1);
}

if (process.argv[2] === "stop") {
  docker("stop", NAME);
  console.log(`stopped ${NAME}; its data stays in the volume ${NAME}-data`);
  process.exit(0);
}

const state = docker("inspect", "--format", "{{.State.Running}}", NAME);
if (state.status !== 0) {
  execFileSync(
    "docker",
    ["run", "-d", "--name", NAME, "-p", `${PORT}:5432`, "-e", "POSTGRES_PASSWORD=rayfold", "-e", "POSTGRES_DB=apps", "-v", `${NAME}-data:/var/lib/postgresql`, "postgres:18-alpine"],
    { stdio: "inherit" },
  );
} else if (state.stdout.trim() !== "true") {
  execFileSync("docker", ["start", NAME], { stdio: "inherit" });
}

// ready means it answers a query, not that the container started
for (let i = 0; i < 60; i++) {
  if (docker("exec", NAME, "pg_isready", "-U", "postgres").status === 0) {
    console.log(`postgres is ready on 127.0.0.1:${PORT} (user postgres, password rayfold, database apps)`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`postgres did not become ready; see: docker logs ${NAME}`);
process.exit(1);
