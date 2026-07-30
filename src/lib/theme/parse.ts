import type { Appearance, ThemeManifest } from "./types";

const COMMENT = /\/\*[\s\S]*?\*\//g;
const DECLARATION = /--([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)[;}]/g;

/* A token value that fetches something is a network request the user did not
 * ask for, from a file they installed for its colours. */
const FETCHES = /(?:^|[^a-z-])(url|image-set|-webkit-image-set|element)\s*\(/i;

/** Reads the custom properties out of a theme's stylesheet, ignoring
 * selectors, at-rules and anything else in the file. A theme is a set of token
 * values; it cannot restyle a component because nothing else is read. */
export function parseStylesheet(css: string): {
  tokens: Record<string, string>;
  problems: string[];
} {
  const tokens: Record<string, string> = {};
  const problems: string[] = [];

  for (const [, name, raw] of css.replace(COMMENT, " ").matchAll(DECLARATION)) {
    const value = raw!.trim();
    const fetches = FETCHES.exec(value);
    if (fetches) {
      problems.push(
        `--${name} uses ${fetches[1]}(). A theme sets colours, not resources: ircx never fetches a remote file on its own. Use a colour value.`,
      );
      continue;
    }
    tokens[`--${name}`] = value;
  }

  return { tokens, problems };
}

const APPEARANCES: readonly Appearance[] = ["light", "dark"];
const VERSION = /^\d+\.\d+\.\d+$/;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Parses `theme.json`. Every failure names the field and says what belongs
 * in it, because the person reading it is holding the file that is wrong. */
export function parseManifest(json: string): {
  manifest: ThemeManifest | null;
  problems: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (reason) {
    return {
      manifest: null,
      problems: [`theme.json is not valid JSON: ${(reason as Error).message}`],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { manifest: null, problems: ["theme.json must hold a JSON object."] };
  }

  const fields = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const name = text(fields.name);
  if (!name) problems.push('theme.json needs "name": the theme\'s name as the picker should show it.');

  const author = text(fields.author);
  if (!author) problems.push('theme.json needs "author": who to credit, or who to ask about it.');

  const version = text(fields.version);
  if (!version) {
    problems.push('theme.json needs "version": three numbers, like "1.2.0".');
  } else if (!VERSION.test(version)) {
    problems.push(`theme.json has "version": "${version}". Use three numbers, like "1.2.0".`);
  }

  const appearance = text(fields.appearance);
  if (!appearance) {
    problems.push(
      'theme.json needs "appearance": "dark" or "light", so scrollbars and native controls are drawn to match.',
    );
  } else if (!APPEARANCES.includes(appearance as Appearance)) {
    problems.push(
      `theme.json has "appearance": "${appearance}". It must be "dark" or "light".`,
    );
  }

  if (problems.length > 0) return { manifest: null, problems };

  return {
    manifest: {
      name: name!,
      author: author!,
      version: version!,
      appearance: appearance as Appearance,
    },
    problems: [],
  };
}
