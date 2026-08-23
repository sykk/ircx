import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/**
 * The port comes from `devUrl`, which is the address Tauri bakes into the
 * binary. It used to be written out here as well, and in `src-tauri/src/lib.rs`
 * a third time; #233 is what three copies of one number cost.
 */
function devPort(): number {
  const conf = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const port = Number(new URL(conf.build.devUrl).port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`src-tauri/tauri.conf.json devUrl has no usable port: ${conf.build.devUrl}`);
  }
  return port;
}

/**
 * Names the checkout this server is serving, on every response.
 *
 * A fixed port means a second checkout's server answers on the address this one
 * expects, and the window that comes up is built from somebody else's working
 * tree — right down to connecting and drawing a conversation. That is worse
 * than a blank window because nothing about it looks wrong. The Rust side
 * compares this header against its own root and refuses. #233.
 */
function namesItsRoot(): Plugin {
  return {
    name: "ircx-names-its-root",
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        response.setHeader("x-ircx-root", ROOT);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), namesItsRoot()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: devPort(),
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: { target: "esnext", sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Vitest blanks CSS imports by default, including `?raw` ones. The theme
    // loader reads the built-in stylesheets that way, so those files — and no
    // others — have to survive the trip.
    css: { include: [/src\/styles\/themes\//] },
    globals: true,
    passWithNoTests: true,
    // Agent worktrees under .claude hold full checkouts; without this vitest
    // collects their tests alongside the real ones.
    exclude: ["node_modules/**", "dist/**", ".claude/**", "target/**"],
  },
});
