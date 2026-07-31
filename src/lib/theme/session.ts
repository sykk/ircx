import { ipc, onThemesChanged } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { ThemeSource } from "@/types";
import { applyDensity, applyOverrides, applyTheme, storeThemeId, storedThemeId } from "./apply";
import { DEFAULT_DENSITY, type DensityId, storeDensity, storedDensity } from "./density";
import { FALLBACK_THEME_ID, catalogue } from "./load";
import { storedOverrides } from "./overrides";

/** The theme the window opens in, resolved from the built-ins alone so it can
 * be applied before the first paint. A theme installed on disk cannot be read
 * synchronously; it lands a moment later, when `startThemes` resolves.
 *
 * The edits made to that theme are read the same way, from localStorage, for
 * the same reason: they are part of what the window looks like, and a window
 * that paints the theme first and the edits a frame later flashes the colour
 * the person changed. Which themes exist has no bearing on which edits are
 * kept — src-tauri/src/themes.rs makes the point that an editor writing
 * through a temporary file makes a theme disappear and come back, so pruning
 * the record against the catalogue would eat someone's work for saving a
 * file. */
export function applyOpeningTheme(): void {
  const wanted = storedThemeId() ?? FALLBACK_THEME_ID;
  const density = storedDensity() ?? DEFAULT_DENSITY;
  const overrides = storedOverrides();
  const { themes } = catalogue();

  useAppStore.setState({ themes, themeId: wanted, density, overrides });
  applyDensity(density);
  applyOverrides(overrides);
  applyTheme(themes.find((theme) => theme.id === wanted) ?? null);
}

/** Puts a theme on the window, remembers it for the next launch and tells the
 * store, in the one place that does all three, so they cannot come apart. The
 * command palette calls this as well, even though it previews a theme as the
 * selection moves and the cleanup of that effect paints the chosen one anyway:
 * that cleanup reads the id out of the store rather than capturing it when the
 * preview began, so the two repaints agree instead of fighting. */
export function selectTheme(id: string): void {
  const { themes, setThemeId } = useAppStore.getState();
  setThemeId(id);
  storeThemeId(id);
  applyTheme(themes.find((theme) => theme.id === id) ?? null);
}

/** The same three things for the density, in one place for the same reason.
 * Two screens offer it now, and a density set on one of them that the other
 * does not remember is the bug this shape exists to make impossible. */
export function selectDensity(id: DensityId): void {
  useAppStore.getState().setDensity(id);
  applyDensity(id);
  storeDensity(id);
}

function publish(installed: ThemeSource[]): void {
  const loaded = catalogue(installed);
  const { themeId, setThemeCatalogue } = useAppStore.getState();
  setThemeCatalogue(loaded);
  applyTheme(loaded.themes.find((theme) => theme.id === themeId) ?? null);

  for (const { id, problems } of loaded.broken) {
    console.warn(`ircx could not load the theme ${id}:\n  ${problems.join("\n  ")}`);
  }
}

/**
 * Reads the themes directory and keeps watching it. A backend that is not
 * there — a browser, or a window whose backend failed to start — leaves the
 * built-in themes in place rather than failing.
 *
 * Resolves to an unsubscribe function.
 */
export async function startThemes(): Promise<() => void> {
  let unlisten = () => {};
  try {
    unlisten = await onThemesChanged(publish);
    publish(await ipc.listThemes());
  } catch (reason) {
    console.warn("ircx could not read the themes directory", reason);
    publish([]);
  }
  return unlisten;
}
