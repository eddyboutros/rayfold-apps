/**
 * The stand-in console on a port of its own, for a fleet started with scripts/dev.mjs: what `e2e/stand-in-console.ts`
 * is to the tests, as a process. It prints one line, `console <url> <token>`, once it listens, and stops on SIGTERM.
 *
 *   npx tsx e2e/browser/console.ts [port]
 *
 * It answers on every interface when HOST is 0.0.0.0, so a fleet in containers can reach it on the host.
 */
import { createServer, connect } from "node:net";
import { startStandInConsole } from "../stand-in-console.ts";

const port = Number(process.argv[2] ?? 0);
const platform = await startStandInConsole();

// the stand-in listens on the loopback; a relay puts it on the port asked for, on the host asked for
const relay = createServer((socket) => {
  const upstream = connect(Number(new URL(platform.url).port), "127.0.0.1");
  socket.pipe(upstream).pipe(socket);
  const end = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", end);
  upstream.on("error", end);
});
await new Promise<void>((resolve) => relay.listen(port, process.env["HOST"] ?? "127.0.0.1", resolve));
const bound = (relay.address() as { port: number }).port;
console.log(`console http://127.0.0.1:${bound} ${platform.token}`);

const stop = async () => {
  relay.close();
  await platform.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
