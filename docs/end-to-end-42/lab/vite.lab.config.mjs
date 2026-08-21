// The driver's browser config with run 40's channel added.
//
// `.claude/skills/run-ircx/vite.browser.config.mjs` injects the seed before the
// app; this injects that and then `merge-seed.mjs` over the top of it, so
// `#merge` is on the sidebar of a client with no backend behind it.
import { resolve } from "node:path";

import base from "../../../vite.config.ts";
import { SEED } from "../../../.claude/skills/run-ircx/seed.mjs";

import { MERGE } from "./merge-seed.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const config = typeof base === "function" ? base({ command: "serve", mode: "development" }) : base;

export default {
  ...config,
  configFile: false,
  root: ROOT,
  plugins: [
    ...(config.plugins ?? []),
    {
      name: "ircx-lab-seed",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html.replace("<head>", `<head><script>${SEED}</script><script>${MERGE}</script>`),
      },
    },
  ],
  // Port 0 rather than the project's pinned 5183, so this never collides with a
  // `tauri dev` or with another checkout's.
  server: { ...config.server, port: 0, strictPort: false },
};
