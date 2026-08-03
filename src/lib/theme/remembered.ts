import type { ThemeSource } from "@/types";

/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.theme.installed";

/**
 * The last theme that came from disk, kept as the two files it arrived as.
 *
 * A built-in theme is compiled in, so the window can paint it before anything
 * async has happened. A theme in `<app data>/themes` cannot be read that way —
 * it takes a command to the backend — so the opening paint had nothing to show
 * for it and fell through to the dark theme `global.css` imports statically.
 * Every launch on an installed theme flashed dark, measured at about 130ms in
 * `docs/end-to-end-run-6.md`, which on a light theme is the whole window.
 *
 * The source rather than the tokens it parses to, so `catalogue` validates this
 * on the way back in exactly as it validates the backend's copy. localStorage
 * is a text file anyone can edit; a cache of already-parsed tokens would be a
 * way around the gates `overrides.ts` describes at length.
 */
export function rememberInstalled(source: ThemeSource | null): void {
  try {
    if (source === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(source));
  } catch {
    /* A window that cannot remember it still paints it, one frame later. */
  }
}

/**
 * What to open on, or `null`. Shape-checked only: what it is worth is decided
 * by `catalogue`, which refuses a theme whose files do not parse.
 */
export function rememberedInstalled(): ThemeSource | null {
  let held: string | null;
  try {
    held = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (held === null) return null;

  try {
    const parsed: unknown = JSON.parse(held);
    if (parsed === null || typeof parsed !== "object") return null;
    const { id, manifest, stylesheet } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id === "") return null;
    if (typeof manifest !== "string" || typeof stylesheet !== "string") return null;
    return { id, manifest, stylesheet };
  } catch {
    return null;
  }
}
