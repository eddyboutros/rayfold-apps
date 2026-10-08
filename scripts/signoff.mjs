#!/usr/bin/env node
/**
 * The sign-off queue from a terminal: clients/signoff, the Kotlin client, run from source with the Maven wrapper.
 *
 *   KEEL_USER=tomas npm run signoff -- inbox
 *   KEEL_USER=tomas npm run signoff -- watch
 *   KEEL_USER=tomas npm run signoff -- approve <id> "Clause 3 is fine."
 *
 * Against the dev fleet's approvals service on :4004 (`npm run dev`); KEEL_APPROVALS points it elsewhere. Needs a
 * JDK 21 or newer, as that service does.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "clients", "signoff");
const mvnw = join(dir, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
// each argument quoted on its own, so a note with spaces stays one argument
const args = process.argv.slice(2).map((a) => `'${a.replace(/'/g, "")}'`).join(" ");
// one command line: on Windows a .cmd file runs through the shell, which takes one
const child = spawn(`"${mvnw}" -q compile exec:java "-Dexec.args=${args.replace(/"/g, "")}"`, { cwd: dir, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
