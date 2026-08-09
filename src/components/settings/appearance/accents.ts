import type { Appearance } from "@/lib/theme";

/**
 * The accents offered as one click, and what each one writes.
 *
 * These are literal colours in a file that is otherwise forbidden them, and
 * the difference is what they are for: a component drawing itself in `#4493f8`
 * has put a colour outside the theme's reach, while these are values handed to
 * a token. The swatch shows the reader the value it is about to write, which
 * is the one case where the colour *is* the content.
 *
 * A list rather than a colour picker, for the reason `PROSE_FACES` is a list —
 * the door opens as far as somebody needs it and no further. Anybody who wants
 * a colour that is not here has the token editor, which is where all three of
 * these tokens can be set apart from each other anyway.
 *
 * Three tokens rather than one, because `--accent` alone is half an accent:
 * `--accent-hover` would stay at whatever the theme's author solved against
 * their own blue, and `--accent-muted` — which is a background, per
 * src/lib/theme/overrides.ts — would tint every mention in the old hue.
 */
export interface Accent {
  name: string;
  /** `--accent` itself, and the colour the swatch is drawn in. */
  base: string;
  /** `--accent-hover` on a dark theme. Hover lifts off a dark ground. */
  lift: string;
  /** `--accent-hover` on a light one, where it has to go the other way. */
  drop: string;
}

export const ACCENTS: readonly Accent[] = [
  { name: "Sky", base: "#4493f8", lift: "#58a6ff", drop: "#1f6feb" },
  { name: "Jade", base: "#3fb950", lift: "#56d364", drop: "#238636" },
  { name: "Violet", base: "#a371f7", lift: "#bc8cff", drop: "#8250df" },
  { name: "Rose", base: "#f778ba", lift: "#ff9bce", drop: "#bf3989" },
  { name: "Amber", base: "#e3963f", lift: "#f0b072", drop: "#bb7526" },
  { name: "Gold", base: "#d5b60a", lift: "#e8ca31", drop: "#9e7b06" },
  { name: "Slate", base: "#8b949e", lift: "#a8b1bb", drop: "#6e7781" },
];

/**
 * The three token values an accent sets on a theme of this appearance.
 *
 * `--accent-muted` is the base at a fifth, written the way the built-in themes
 * write it — eight-digit hex — so an accent chosen here and one edited by hand
 * are the same kind of value.
 */
export function accentTokens(accent: Accent, appearance: Appearance): Record<string, string> {
  return {
    "--accent": accent.base,
    "--accent-hover": appearance === "light" ? accent.drop : accent.lift,
    "--accent-muted": `${accent.base}33`,
  };
}
