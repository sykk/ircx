export type Appearance = "light" | "dark";

/** `theme.json`. Everything the picker shows, plus the one thing a stylesheet
 * cannot say for itself: whether the window's native widgets should be drawn
 * light or dark. */
export interface ThemeManifest {
  name: string;
  author: string;
  version: string;
  appearance: Appearance;
}

/** A theme that passed validation. `tokens` maps `--surface-base` to its
 * value; nothing else in the stylesheet is read, so a theme cannot restyle a
 * component or reach outside the token contract. */
export interface Theme {
  id: string;
  manifest: ThemeManifest;
  tokens: Record<string, string>;
}

export type ThemeLoad =
  | { ok: true; theme: Theme }
  | { ok: false; id: string; problems: string[] };
