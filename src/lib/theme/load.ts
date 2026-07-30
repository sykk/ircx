import type { ThemeSource } from "@/types";
import { parseManifest, parseStylesheet } from "./parse";
import type { Theme, ThemeLoad } from "./types";

import darkManifest from "@/styles/themes/ircx-dark/theme.json?raw";
import darkStylesheet from "@/styles/themes/ircx-dark/theme.css?raw";
import lightManifest from "@/styles/themes/ircx-light/theme.json?raw";
import lightStylesheet from "@/styles/themes/ircx-light/theme.css?raw";

/** Every custom property the UI reads, taken from the theme that defines them
 * all. Deriving the list rather than writing it down is what keeps a token
 * added to the dark theme from being optional everywhere else. */
export const REQUIRED_TOKENS: readonly string[] = Object.keys(
  parseStylesheet(darkStylesheet).tokens,
).sort();

/** The theme every failure lands on, and the only one global.css imports
 * statically. */
export const FALLBACK_THEME_ID = "ircx-dark";

export const BUILT_IN_SOURCES: readonly ThemeSource[] = [
  { id: FALLBACK_THEME_ID, manifest: darkManifest, stylesheet: darkStylesheet },
  { id: "ircx-light", manifest: lightManifest, stylesheet: lightStylesheet },
];

const BUILT_IN_IDS = new Set(BUILT_IN_SOURCES.map((source) => source.id));

/** Validates one theme directory. Nothing here throws: a theme is a file
 * someone else wrote, and the worst it may do is fail to load. */
export function loadTheme(source: ThemeSource): ThemeLoad {
  const problems: string[] = [];

  if (source.manifest.trim() === "") {
    problems.push(`${source.id} has no theme.json. A theme is theme.json and theme.css together.`);
  }
  if (source.stylesheet.trim() === "") {
    problems.push(`${source.id} has no theme.css. A theme is theme.json and theme.css together.`);
  }
  if (problems.length > 0) return { ok: false, id: source.id, problems };

  const { manifest, problems: manifestProblems } = parseManifest(source.manifest);
  const { tokens, problems: stylesheetProblems } = parseStylesheet(source.stylesheet);
  problems.push(...manifestProblems, ...stylesheetProblems);

  const missing = REQUIRED_TOKENS.filter((token) => !(token in tokens));
  if (missing.length > 0) {
    problems.push(
      `theme.css leaves ${missing.length === 1 ? "one property" : `${missing.length} properties`} undefined: ${missing.join(", ")}. ` +
        "Give each one a value; copying it from src/styles/themes/ircx-dark/theme.css and changing it is the usual way.",
    );
  }

  if (!manifest || problems.length > 0) return { ok: false, id: source.id, problems };
  return { ok: true, theme: { id: source.id, manifest, tokens } };
}

export interface BrokenTheme {
  id: string;
  problems: string[];
}

export interface Catalogue {
  themes: Theme[];
  broken: BrokenTheme[];
}

/** The built-in themes plus whatever the themes directory holds. A theme that
 * fails to load is kept as a `broken` entry rather than dropped, so the picker
 * can say what is wrong with it instead of quietly not listing it. */
export function catalogue(installed: readonly ThemeSource[] = []): Catalogue {
  const themes: Theme[] = [];
  const broken: BrokenTheme[] = [];

  for (const source of BUILT_IN_SOURCES) {
    const load = loadTheme(source);
    if (load.ok) themes.push(load.theme);
    else broken.push({ id: load.id, problems: load.problems });
  }

  for (const source of installed) {
    if (BUILT_IN_IDS.has(source.id)) {
      broken.push({
        id: source.id,
        problems: [`${source.id} is the name of a built-in theme. Rename the directory.`],
      });
      continue;
    }

    const load = loadTheme(source);
    if (load.ok) themes.push(load.theme);
    else broken.push({ id: load.id, problems: load.problems });
  }

  return { themes, broken };
}
