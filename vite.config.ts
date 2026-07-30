import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Tauri drives the dev server; a fixed port and a hard failure on conflict keep
// the Rust side's devUrl honest.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5183,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: { target: "esnext", sourcemap: true },
  test: {
    environment: "jsdom",
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
