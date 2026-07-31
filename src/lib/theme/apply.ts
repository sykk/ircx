import { DEFAULT_DENSITY, densityTokens, type DensityId } from "./density";
import type { Theme } from "./types";

/** Mirrors src/components/shell/viewState.ts: a preference the backend has no
 * reason to know about lives next to the other window state. */
const STORAGE_KEY = "ircx.theme";

let applied: string[] = [];
/* A theme and a density both state `--timeline-row-pad-y` and its two
 * neighbours, and both write them to the same inline declaration on the root.
 * Painting either one alone would clear the other's value along with its own,
 * so both are held here and every change repaints from the pair. */
let theme: Theme | null = null;
let density: DensityId = DEFAULT_DENSITY;

/** Writes the theme's tokens onto the root element. `null` removes them,
 * which uncovers the built-in dark theme that global.css imports statically —
 * that stylesheet is the floor, and it is why no failure can leave the window
 * without colours. */
export function applyTheme(next: Theme | null): void {
  theme = next;
  paint();
}

/** The density overrides three of the theme's tokens; the rest of it stands. */
export function applyDensity(next: DensityId): void {
  density = next;
  paint();
}

function paint(): void {
  const root = document.documentElement;
  const tokens = { ...(theme?.tokens ?? {}), ...densityTokens(density) };

  for (const name of applied) root.style.removeProperty(name);
  applied = Object.keys(tokens);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
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
