import type { Theme } from "./types";

/** Mirrors src/components/shell/viewState.ts: a preference the backend has no
 * reason to know about lives next to the other window state. */
const STORAGE_KEY = "ircx.theme";

let applied: string[] = [];

/** Writes the theme's tokens onto the root element. `null` removes them,
 * which uncovers the built-in dark theme that global.css imports statically —
 * that stylesheet is the floor, and it is why no failure can leave the window
 * without colours. */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;

  for (const name of applied) root.style.removeProperty(name);
  applied = theme ? Object.keys(theme.tokens) : [];
  if (theme) {
    for (const [name, value] of Object.entries(theme.tokens)) {
      root.style.setProperty(name, value);
    }
  }

  root.style.colorScheme = theme?.manifest.appearance ?? "dark";
  root.dataset.theme = theme?.id ?? "ircx-dark";
}

export function storedThemeId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeThemeId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* A window that cannot remember the theme still renders it. */
  }
}
