import { DEFAULT_DENSITY, densityTokens, type DensityId } from "./density";
import type { Overrides } from "./overrides";
import type { Theme } from "./types";
import { applyUiStylesheet } from "./ui-css";

/** Mirrors src/components/shell/viewState.ts: a preference the backend has no
 * reason to know about lives next to the other window state. */
const STORAGE_KEY = "ircx.theme";

let applied: string[] = [];
/* A theme, a person's edits to it and a density all state the same tokens —
 * `--timeline-row-pad-y` and its two neighbours are in every one of them — and
 * all three write to the same inline declaration on the root. Painting any one
 * alone would clear the others' values along with its own, so the trio is held
 * here and every change repaints from all three. */
let theme: Theme | null = null;
let overrides: Overrides = {};
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

/** The whole record, every theme's edits at once. What gets painted is the
 * entry for the theme in force, so this can be set before the theme is known
 * and stays right across every change of theme after it. */
export function applyOverrides(next: Overrides): void {
  overrides = next;
  paint();
}

function paint(): void {
  const root = document.documentElement;
  /* The theme's own values, then whatever this person changed about that same
   * theme, then the density. Reading the edits under the theme's id rather
   * than keeping one flat set is what stops three separate things going
   * wrong: the palette's live preview shows a theme wearing its own edits
   * instead of the previous theme's; `applyTheme(null)` merges nothing, so a
   * window whose theme failed to load opens on the plain dark theme rather
   * than with a custom accent painted over it; and an edit made while two
   * themes are in play belongs to exactly one of them. */
  const edits = theme ? overrides[theme.id] : undefined;
  const tokens = { ...(theme?.tokens ?? {}), ...edits, ...densityTokens(density) };

  for (const name of applied) root.style.removeProperty(name);
  applied = Object.keys(tokens);
  for (const [name, value] of Object.entries(tokens)) {
    root.style.setProperty(name, value);
  }

  root.style.colorScheme = theme?.manifest.appearance ?? "dark";
  root.dataset.theme = theme?.id ?? "ircx-dark";
  applyUiStylesheet(theme?.uiStylesheet ?? "");
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
