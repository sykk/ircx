import { ipc, onThemesChanged } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { ThemeSource } from "@/types";
import { applyDensity, applyOverrides, applyTheme, storeThemeId, storedThemeId } from "./apply";
import { DEFAULT_DENSITY, type DensityId, storeDensity, storedDensity } from "./density";
import { FALLBACK_THEME_ID, catalogue } from "./load";
import { storedOverrides } from "./overrides";
import { type Presentation, storePresentation, storedPresentation } from "./presentation";
import { rememberInstalled, rememberedInstalled } from "./remembered";

/** The theme the window opens in, resolved before the first paint: the
 * built-ins, plus the installed theme the last run painted, which is kept in
 * localStorage because reading the themes directory takes a command to the
 * backend and the first paint cannot wait for one.
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
  const presentation = storedPresentation();
  const remembered = rememberedInstalled();
  const { themes } = catalogue(remembered ? [remembered] : []);

  useAppStore.setState({ themes, themeId: wanted, density, overrides, presentation });
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
  /* The id alone is not enough to paint an installed theme on the next launch,
   * so the files go with it. Choosing a built-in clears the record: the id
   * would resolve without it, and a stale copy of a theme nobody is using is
   * a stale copy waiting to be painted. */
  rememberInstalled(fromDisk.find((source) => source.id === id) ?? null);
}

/** The same three things for the density, in one place for the same reason.
 * Two screens offer it now, and a density set on one of them that the other
 * does not remember is the bug this shape exists to make impossible. */
export function selectDensity(id: DensityId): void {
  useAppStore.getState().setDensity(id);
  applyDensity(id);
  storeDensity(id);
}

/** One field of the presentation, merged over the rest. There is nothing to
 * paint: none of the three is a token, so the components that draw the spine,
 * the clock and the nickname read them from the store. */
export function selectPresentation(change: Partial<Presentation>): void {
  const next = { ...useAppStore.getState().presentation, ...change };
  useAppStore.getState().setPresentation(next);
  storePresentation(next);
}

/** The themes directory as the backend last sent it. Held because what has to
 * be written down for the next launch is the two files a theme arrived as, and
 * everything downstream of `catalogue` has parsed them into tokens. */
let fromDisk: ThemeSource[] = [];

function publish(installed: ThemeSource[]): void {
  fromDisk = installed;
  const loaded = catalogue(installed);
  const { themeId, setThemeCatalogue } = useAppStore.getState();
  setThemeCatalogue(loaded);
  applyTheme(loaded.themes.find((theme) => theme.id === themeId) ?? null);

  /* Kept from what the backend just sent rather than from the catalogue, so
   * the next launch opens on the same two files this one was given. A theme in
   * force that is not in this list has been deleted or renamed, and the window
   * has already fallen back above — remembering it would open the next launch
   * on a theme that is gone. */
  rememberInstalled(installed.find((source) => source.id === themeId) ?? null);

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
