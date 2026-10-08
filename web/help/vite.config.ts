/**
 * The help centre's build and its dev server.
 *
 * It lives at /help/ on the same origin as Keel, behind the same gateway, and reads two services there. The dev server
 * answers the same paths through a proxy, as every front end here does, with one difference that is the point of the
 * page: what reaches the catalogue carries no cookie and no Authorization, so every read is an anonymous one, exactly
 * as the gateway's shared cache sees it in production. The feedback service is the one that wants a cookie: the
 * visitor's own.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const anonymous = {
  configure: (proxy: { on: (event: "proxyReq", fn: (req: { removeHeader: (name: string) => void }) => void) => void }) => {
    proxy.on("proxyReq", (req) => {
      req.removeHeader("cookie");
      req.removeHeader("authorization");
    });
  },
};

export default defineConfig({
  base: "/help/",
  plugins: [react()],
  build: { outDir: "dist/help/browser", emptyOutDir: true },
  server: {
    port: 4204,
    // the design tokens are one directory up, shared with every other front end here
    fs: { allow: [".."] },
    proxy: {
      "/api/help": { target: process.env["CATALOGUE_URL"] ?? "http://localhost:4003", changeOrigin: true, rewrite: (p) => p.replace(/^\/api\/help/, ""), ...anonymous },
      "/api/feedback": { target: process.env["FEEDBACK_URL"] ?? "http://localhost:4005", rewrite: (p) => p.replace(/^\/api\/feedback/, "") },
    },
  },
});
