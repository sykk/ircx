import { ipc, onThemesChanged } from "@/lib/ipc";
import { useAppStore } from "@/store";
import type { ThemeSource } from "@/types";
import { applyDensity, applyTheme, storedThemeId } from "./apply";
import { DEFAULT_DENSITY, storedDensity } from "./density";
import { FALLBACK_THEME_ID, catalogue } from "./load";

/** The theme the window opens in, resolved from the built-ins alone so it can
 * be applied before the first paint. A theme installed on disk cannot be read
 * synchronously; it lands a moment later, when `startThemes` resolves. */
export function applyOpeningTheme(): void {
  const wanted = storedThemeId() ?? FALLBACK_THEME_ID;
  const density = storedDensity() ?? DEFAULT_DENSITY;
  const { themes } = catalogue();

  useAppStore.setState({ themes, themeId: wanted, density });
  applyDensity(density);
  applyTheme(themes.find((theme) => theme.id === wanted) ?? null);
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
