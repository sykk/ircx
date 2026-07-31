import type { Appearance, ThemeManifest } from "./types";

const COMMENT = /\/\*[\s\S]*?\*\//g;
const DECLARATION = /--([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)[;}]/g;

/* A token value that fetches something is a network request the user did not
 * ask for, from a file they installed for its colours. */
const FETCHES = /(?:^|[^a-z-])(url|image-set|-webkit-image-set|element)\s*\(/i;

/* Every value here ends at `setProperty`, whether it was read out of a
 * theme.css or typed into the appearance editor, and a custom property whose
 * value is not a `<declaration-value>` is refused there without a word: no
 * throw, no return value, the token simply never lands. An unset token is the
 * failure src/lib/theme/overrides.ts argues against for "" — it uncovers the
 * dark theme global.css imports statically, so ircx-light paints a dark
 * surface — and reaching it is as ordinary as pasting `#0969da;` straight out
 * of a stylesheet.
 *
 * Refused is only what no further typing can rescue: a `;` or a `!` outside
 * any bracket, and a bracket that closes one which was never opened. The other
 * half of the grammar, a bracket left open, is deliberately let through,
 * because the editor commits every keystroke and `rgb(31 35 40 / 0.42` is what
 * `--scrim` looks like halfway through being typed. */
function strayChar(value: string): string | null {
  let open = 0;
  for (const char of value) {
    if (char === "(" || char === "[" || char === "{") {
      open += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      if (open === 0) return char;
      open -= 1;
    } else if (open === 0 && (char === ";" || char === "!")) {
      return char;
    }
  }
  return null;
}

/** What is wrong with one token's value, in a sentence for whoever wrote it,
 * or null when nothing is. Stated once and used twice: a stylesheet is not the
 * only way a value reaches the root element, and a value typed into the
 * appearance editor has to clear the same bar as one read from a file. */
export function tokenProblem(token: string, value: string): string | null {
  const fetches = FETCHES.exec(value);
  if (fetches) {
    return `${token} uses ${fetches[1]}(). A theme sets colours, not resources: ircx never fetches a remote file on its own. Use a colour value.`;
  }

  const stray = strayChar(value);
  if (stray !== null) {
    return `${token} has a ${stray} in its value. A browser drops a custom property whose value it cannot parse, without a word, so the token would be left unset rather than changed. Give the value on its own, without it.`;
  }

  return null;
}

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
    const problem = tokenProblem(`--${name}`, value);
    if (problem) {
      problems.push(problem);
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
