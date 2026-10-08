#!/usr/bin/env node
/**
 * One service's contract served with made-up data, for building a screen before the service has what it needs.
 *
 *   npm run mock -- catalogue            # http://localhost:4503/rayfold, and the explorer at /rayfold/explorer
 *   npm run mock -- feedback --port 4600
 *
 * `rayfold mock` reads nothing but the service's `.rayfold` file: every operation answers with values its types
 * describe (the same request, the same answer, so a screen does not flicker), and no database, no other service and
 * no sign-in is involved. Each mock sits 500 above the service's own port, so a front end's dev server can be pointed
 * at it instead: `CATALOGUE_URL=http://localhost:4503 npm start` in web/help.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = {
  documents: { file: "services/documents/src/documents.rayfold", port: 4501 },
  workspace: { file: "services/workspace/src/workspace.rayfold", port: 4502 },
  catalogue: { file: "services/catalogue/src/catalogue.rayfold", port: 4503 },
  approvals: { file: "services/approvals/src/main/resources/approvals.rayfold", port: 4504 },
  feedback: { file: "services/feedback/src/feedback.rayfold", port: 4505 },
};

const [name, ...rest] = process.argv.slice(2);
const schema = name ? SCHEMAS[name] : undefined;
if (!schema) {
  console.error(`which service? one of: ${Object.keys(SCHEMAS).join(", ")}`);
  process.exit(2);
}
const at = rest.indexOf("--port");
const port = at >= 0 ? rest[at + 1] : String(schema.port);

// one command line: npx is a .cmd file on Windows, which runs through the shell
const child = spawn(`npx rayfold mock ${schema.file} --port ${port}`, { cwd: root, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
