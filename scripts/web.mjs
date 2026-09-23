#!/usr/bin/env node
/**
 * The four front ends' dev servers, remotes first: the shell on :4200 loads the others at runtime.
 *
 *   npm run web             # installs each web project the first time, then serves all four
 *
 * Each is its own npm project with its own lockfile (web/README.md says why), so this is four `ng serve`s rather than
 * one. Ctrl+C stops them all. Open http://localhost:4200 once "ready" is printed for the shell.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const apps = [
  { name: "documents-ui", port: 4202 },
  { name: "workspace-ui", port: 4201 },
  { name: "catalogue-ui", port: 4203 },
  { name: "shell", port: 4200 },
];
for (const app of apps) {
  if (existsSync(join(web, app.name, "node_modules"))) continue;
  console.log(`[${app.name}] npm install (first run only)`);
  const done = spawnSync("npm install", { cwd: join(web, app.name), stdio: "inherit", shell: true });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const children = apps.map((app) => {
  // one command line: npm and npx are .cmd files on Windows, which run through the shell
  const child = spawn(`npx ng serve --port ${app.port}`, { cwd: join(web, app.name), stdio: ["ignore", "pipe", "pipe"], shell: true });
  const tag = `[${app.name}] `;
  const forward = (stream, out) =>
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        out.write(tag + line + "\n");
        // the dev server colours its output, so the colour codes go before the line is read
        if (/Local:/.test(line.replace(/\x1b\[[0-9;]*m/g, ""))) out.write(`${tag}ready on http://localhost:${app.port}\n`);
      }
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return child;
});

const stop = () => {
  // each server runs under a shell; on Windows killing the shell leaves the server behind, so the whole tree goes
  for (const c of children) {
    if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill();
  }
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
