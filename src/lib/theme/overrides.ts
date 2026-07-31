import { tokenProblem } from "./parse";
import { REQUIRED_TOKENS } from "./tokens";

/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.theme.overrides";

/**
 * What a person changed about a theme, keyed by the theme it belongs to and
 * then by token. Keyed rather than flat because an edit is an edit to one
 * palette: an accent chosen against the dark surfaces is not the accent that
 * theme's author would have picked for the light ones.
 */
export type Overrides = Record<string, Record<string, string>>;

const ALLOWED = new Set(REQUIRED_TOKENS);

/**
 * The overrides worth painting, from anything at all.
 *
 * localStorage is a text file the user can edit, so what comes back is
 * untrusted input rather than what was written, and everything below assumes
 * it was written by someone hostile. Two gates, both of which have to hold for
 * an entry to survive:
 *
 * Gate one, the name is a token this theme system defines. `setProperty` takes
 * ordinary CSS properties as happily as custom ones, so an entry reading
 * `{"background": "url(https://tracker/x)"}` would otherwise put an inline
 * background on `<html>` and fetch it — a stylesheet-shaped hole in a system
 * whose whole claim is that a theme sets token values and cannot restyle a
 * component. The same gate is what keeps typography out of a theme's reach:
 * Tailwind's `@theme` block in src/styles/tokens.css emits `--font-ui` and
 * `--font-mono` onto `:root`, an inline value on the root element would beat
 * them, and they are absent from REQUIRED_TOKENS only because that list is
 * derived from theme.css. Being able to change the font is a decision nobody
 * has taken; it must not arrive by accident through this door.
 *
 * Gate two, the value would be accepted in a theme.css: `tokenProblem` refuses
 * both what fetches and what `setProperty` would drop on the floor.
 * `--mention-bg` and `--accent-muted` are consumed as backgrounds, so a
 * `url()` in either fetches a remote file the moment a mention is drawn, which
 * is exactly the one security property src/lib/theme/parse.ts states the theme
 * system has.
 *
 * A blank value is the one thing that gate cannot see, because "" parses, and
 * it is dropped here instead — an override is a value, and writing "" through
 * `setProperty` removes the property rather than setting it, which uncovers
 * the dark theme global.css imports statically and paints a dark value on a
 * light theme's surface.
 */
export function sanitiseOverrides(raw: unknown): Overrides {
  const kept: Overrides = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return kept;

  for (const [themeId, edits] of Object.entries(raw as Record<string, unknown>)) {
    /* Assigning `__proto__` replaces the record's prototype instead of adding
     * an entry to it, so the edits would be silently unreachable rather than
     * refused. Nothing paints either way; this keeps the record a plain map. */
    if (themeId === "__proto__") continue;
    if (typeof edits !== "object" || edits === null || Array.isArray(edits)) continue;

    const tokens: Record<string, string> = {};
    for (const [token, value] of Object.entries(edits as Record<string, unknown>)) {
      if (!ALLOWED.has(token)) continue;
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed === "" || tokenProblem(token, trimmed)) continue;
      tokens[token] = trimmed;
    }
    kept[themeId] = tokens;
  }

  return kept;
}

/** What the last session left, or nothing. A blob that will not parse is a
 * blob nobody can use, and losing a few edits is better than a window that
 * does not open. */
export function storedOverrides(): Overrides {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    return held === null ? {} : sanitiseOverrides(JSON.parse(held));
  } catch {
    return {};
  }
}

export function storeOverrides(next: Overrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* A window that cannot remember an edit still shows it. */
  }
}
