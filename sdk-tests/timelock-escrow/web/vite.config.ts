import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");
const ZK = join(REPO, "target/zk/timelock-escrow-program");
const OFFSET = Number(process.env["ZOLANA_PORT_OFFSET"] ?? 0);
const port = (base: number) => String(base + OFFSET);
export const APP_PORT = 5180 + OFFSET;
const ESCROW_PROGRAM_ID =
  process.env["TIMELOCK_ESCROW_PROGRAM_ID"] ?? "2ehy1rrRKT3KEVNN6pLmHeiUedwazPZezXXhwaLjCt5G";

// The threaded prover needs SharedArrayBuffer, which needs cross-origin isolation.
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pk": "application/octet-stream",
};

// The escrow WASM package, its proving keys and the prover worker are served
// unbundled: wasm-bindgen-rayon's worker helper imports the package by relative
// URL, which a bundler would break.
const MOUNTS: readonly (readonly [string, string, (rest: string) => boolean])[] = [
  ["/worker/", join(HERE, "worker"), (rest) => rest === "prover-worker.js"],
  ["/escrow-wasm/", join(ZK, "wasm"), () => true],
  ["/keys/", ZK, (rest) => rest === "escrow.pk" || rest === "withdraw.pk"],
];

function escrowAssets(): Plugin {
  return {
    name: "escrow-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
        const mount = MOUNTS.find(([prefix]) => pathname.startsWith(prefix));
        if (mount === undefined) return next();
        const [prefix, root, allowed] = mount;
        const rest = pathname.slice(prefix.length);
        const file = resolve(root, rest);
        if (
          !allowed(rest) ||
          !file.startsWith(root + sep) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          response.writeHead(404, ISOLATION).end(`not found: ${pathname}`);
          return;
        }
        response.writeHead(200, {
          ...ISOLATION,
          "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        createReadStream(file).pipe(response);
      });
    },
  };
}

function strip(prefix: string): (path: string) => string {
  return (path) => path.slice(prefix.length) || "/";
}

export default defineConfig({
  plugins: [escrowAssets()],
  define: { __ESCROW_PROGRAM_ID__: JSON.stringify(ESCROW_PROGRAM_ID) },
  server: {
    host: "127.0.0.1",
    port: APP_PORT,
    strictPort: true,
    headers: ISOLATION,
    // The prover sends no CORS headers, so every service is reached on this origin.
    proxy: {
      "/rpc-ws": {
        target: `ws://127.0.0.1:${port(8900)}`,
        ws: true,
        rewrite: strip("/rpc-ws"),
      },
      "/rpc": { target: `http://127.0.0.1:${port(8899)}`, rewrite: strip("/rpc") },
      "/photon": { target: `http://127.0.0.1:${port(8784)}`, rewrite: strip("/photon") },
      "/prover": { target: `http://127.0.0.1:${port(3001)}`, rewrite: strip("/prover") },
    },
  },
});
