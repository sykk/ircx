import { SECTIONS, isSectionId, type SectionId } from "./sections";

/** Mirrors `SETTINGS_URL` in src-tauri/src/commands.rs, which is what the
 * settings window is pointed at. */
const SETTINGS_QUERY = "settings";

/**
 * Whether this page is the settings window rather than the client.
 *
 * Both are the same `index.html` under one bundle, and the query is what tells
 * them apart. Read off the URL rather than off the window's label — which
 * would answer too — because a label is only readable inside a Tauri webview,
 * and this way the page comes up in a plain browser at `/?settings` for the
 * layout walks under `.claude/skills/run-ircx`.
 */
export function isSettingsPage(): boolean {
  return new URLSearchParams(window.location.search).has(SETTINGS_QUERY);
}

/**
 * The section the window was opened on.
 *
 * The query is a URL a person can edit, so a name that is not a section falls
 * back to the first rather than leaving the window with no page at all.
 */
export function openingSection(): SectionId {
  const asked = new URLSearchParams(window.location.search).get(SETTINGS_QUERY) ?? "";
  return isSectionId(asked) ? asked : SECTIONS[0]!.id;
}

export { SettingsWindow } from "./SettingsWindow";
