// Vite config for driving the ircx frontend in a plain browser.
//
// The app normally runs inside a Tauri webview, where `window.__TAURI_INTERNALS__`
// exists. Several call sites reach for it without checking — `onFileDrop` in
// src/lib/ipc.ts calls `getCurrentWindow()` the moment <DropToUpload> mounts —
// and the resulting synchronous throw unmounts the whole React tree, leaving a
// window that is the right colour and completely empty.
//
// So this injects just enough of those globals for the app to mount, with every
// `invoke` rejecting. Rejecting is the honest answer: it is the backend-absent
// path the app already handles (startThemes falls back to the built-in themes,
// the bridge reports that it could not reach its backend), so what renders is
// the real UI in a real degraded state rather than a mock.
//
// With `--seeded` the driver sets `IRCX_SEEDED` and `seed.mjs` answers instead,
// so the parts of the client that need a conversation can be walked at all. The
// rejecting stub stays the default: it is the state the app is designed to
// degrade into, and a walk of the shell should see it.
//
// This file exists so none of that has to be patched into the repo. It wraps the
// project's own config rather than restating it, so a change to the port, the
// alias or the plugin list is picked up here too.
import { fileURLToPath } from "node:url";
import base from "../../../vite.config.ts";
import { SEED } from "./seed.mjs";

const STUB = `
window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
  transformCallback: (cb) => {
    const id = Math.floor(Math.random() * 1e9);
    window["_" + id] = cb;
    return id;
  },
  invoke: () => Promise.reject("no backend: the frontend is running in a browser"),
};
`;

const stub = process.env.IRCX_SEEDED ? SEED : STUB;

/** Vite resolves `base` lazily when it is a function; the project's is an
 * object, so it is spread directly. */
const config = typeof base === "function" ? base({ command: "serve", mode: "development" }) : base;

export default {
  ...config,
  configFile: false,
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  plugins: [
    ...(config.plugins ?? []),
    {
      name: "ircx-tauri-stub",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => html.replace("<head>", `<head><script>${stub}</script>`),
      },
    },
  ],
  server: {
    ...config.server,
    // The project pins 5183 with strictPort so Tauri's devUrl cannot drift.
    // A driver that inherited that would collide with a Tauri dev server, or
    // with another agent's, and fail to start. Port 0 asks for a free one.
    port: 0,
    strictPort: false,
  },
};
