#!/usr/bin/env node
/**
 * The fleet in development: the four services on their own ports, against the Postgres from `npm run db`, each one's
 * output prefixed with its name. Ctrl+C stops them all.
 *
 *   npm run dev                    # documents :4001, workspace :4002, catalogue :4003, approvals :4004
 *   npm run dev -- --no-jvm        # without the Kotlin service, for a machine with no JDK
 *
 * The front ends' dev servers (`npm run web`) proxy /api/<service> to these ports, so the browser sees one origin, as
 * it does behind the gateway in production. Set CONSOLE_URL and CONSOLE_TOKEN in your environment to put the fleet
 * on a Rayfold Console; without them every service runs on its own, which is the normal case (see the README).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withJvm = !process.argv.includes("--no-jvm");
const files = join(tmpdir(), "rayfold-apps");
mkdirSync(join(files, "files"), { recursive: true });
mkdirSync(join(files, "uploads"), { recursive: true });

// the same values for every service: one database, one secret for capability tokens, one token for /rayfold/stats
const shared = {
  DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://postgres:rayfold@127.0.0.1:55432/apps",
  CAPABILITY_SECRET: process.env["CAPABILITY_SECRET"] ?? "a-development-secret-at-least-16",
  OPS_TOKEN: process.env["OPS_TOKEN"] ?? "dev-ops-token",
  SERVICE_VERSION: "dev",
  APP_ENVIRONMENT: "development",
};

const node = (name, port, extra = {}) => ({
  name,
  command: process.execPath,
  args: ["--import", "tsx", join(root, "services", name, "src", "main.ts")],
  cwd: root,
  env: { PORT: String(port), SELF_URL: `http://localhost:${port}`, ...extra },
});

const services = [
  node("documents", 4001, { FILES_DIR: join(files, "files"), UPLOADS_DIR: join(files, "uploads"), PUBLIC_BASE: "/files" }),
  node("workspace", 4002, { DOCUMENTS_PROJECT: "p1" }),
  node("catalogue", 4003),
];

if (withJvm) {
  const approvals = join(root, "services", "approvals");
  const jar = join(approvals, "target", "approvals-0.1.0.jar");
  if (!existsSync(jar)) {
    console.log("[approvals] building the jar once (./mvnw package); later starts reuse it");
    // by its full path: a Windows shell does not always look in the working directory for a command
    const mvnw = join(approvals, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
    // one command line rather than an argument list: on Windows a .cmd file runs through the shell, which takes one
    const built = spawnSync(`"${mvnw}" -q -B package -DskipTests`, { cwd: approvals, stdio: "inherit", shell: true });
    if (built.status !== 0) {
      console.error("[approvals] the build failed: it needs a JDK 21 or newer. Run with --no-jvm to start the rest without it.");
      process.exit(1);
    }
  }
  services.push({ name: "approvals", command: "java", args: ["-jar", jar], cwd: approvals, env: { PORT: "4004" } });
}

const colours = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m"];
const children = services.map((s, i) => {
  const child = spawn(s.command, s.args, { cwd: s.cwd, env: { ...process.env, ...shared, ...s.env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `${colours[i % colours.length]}[${s.name}]\x1b[0m `;
  const print = (stream, out) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) out.write(tag + line + "\n");
    });
  };
  print(child.stdout, process.stdout);
  print(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) console.error(`${tag}exited with ${code}; the others keep running`);
  });
  return child;
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
