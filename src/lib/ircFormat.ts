/**
 * mIRC formatting codes, drawn against the theme's own tokens.
 *
 * This file used to strip them, and the argument for stripping was that mIRC's
 * colours have nowhere to land: `readability/READABILITY.md` reserves the warm
 * hues for security state, `src/styles/tokens.test.ts` holds the nick palette
 * inside 186-335deg, and a literal `#FF0000` on the screen is colour from
 * outside the token system — the one thing `src/lib/theme/overrides.ts` exists
 * to prevent.
 *
 * What that argument ruled out was the *literal* palette, not the codes. A
 * colour code is an index, and nothing says the index has to resolve to the RGB
 * value mIRC shipped with. Here it resolves to an expression built from the
 * tokens the active theme already defines, so a coloured line is drawn in the
 * theme's own red rather than in a red the theme has never heard of. Nothing
 * below emits a literal colour, which is what keeps the contract intact.
 *
 * Two axes come out of the code, and both are read off its number rather than
 * off a table of RGB values:
 *
 * Hue. Codes 16-87 are six rows of twelve hues stepping thirty degrees from
 * red, which is why `(code - 16) % 12` is the hue and no colour table is needed
 * to find it. The twelve land on eight colour tokens, with the four gaps
 * between neighbours filled by mixing the two tokens either side — an orange
 * that is half this theme's red and half its amber is orange in every theme,
 * and is still nothing but tokens.
 *
 * Shade. `Math.floor((code - 16) / 12)` is the row, darkest to lightest, and a
 * row mixes its hue toward `--surface-base` or `--text-primary`. The dimmest
 * row comes out nearly unreadable, which is what the dimmest row is in every
 * other client too.
 *
 * The sixteen classic codes are the same two axes, assigned by hand in
 * `CLASSIC` because they predate the wheel and are not evenly spaced on it.
 *
 * Greyscale is the exception: 0, 1, 14, 15 and 88-98 carry no hue, so they run
 * along the ramp from `--surface-base` to `--text-primary` instead. That makes
 * the ramp one of prominence rather than of lightness, and mIRC's black comes
 * out faint rather than black. On a dark theme the alternative is text the
 * colour of the surface behind it, which is not a rendering of what the sender
 * meant so much as a refusal to render it.
 */
import type { Block, Span } from "./markdown";

/** What the codes seen so far leave in force. Flat rather than nested: mIRC
 * formatting is a state machine over the line, not a tree, and `\x02` closes
 * whatever `\x02` opened regardless of what was opened in between. */
export interface IrcStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  mono: boolean;
  reverse: boolean;
  /** A colour code, 0-98. Null is the colour the theme would have used. */
  fg: number | null;
  bg: number | null;
}

export const PLAIN: IrcStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  mono: false,
  reverse: false,
  fg: null,
  bg: null,
};

export function isPlain(style: IrcStyle): boolean {
  return (
    !style.bold &&
    !style.italic &&
    !style.underline &&
    !style.strike &&
    !style.mono &&
    !style.reverse &&
    style.fg === null &&
    style.bg === null
  );
}

export interface IrcRun {
  text: string;
  style: IrcStyle;
}

// eslint-disable-next-line no-control-regex
const FORMATTING = /\x03(\d{1,2}(,\d{1,2})?)?|\x04([\da-f]{6}(,[\da-f]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/gi;

/**
 * The line with every code taken out, for the places that quote a message
 * rather than render it: excerpts, search snippets, the digest rows.
 *
 * `\x03` and `\x04` take their numeric arguments with them. Those digits are
 * ordinary characters, and leaving them behind turns a coloured line into a
 * line with stray numbers in it.
 */
export function stripIrcFormatting(text: string): string {
  return text.replace(FORMATTING, "");
}

/** Whether drawing this line differs from printing it, which is what decides
 * if the composer owes the writer a preview of it. */
export function hasIrcFormatting(text: string): boolean {
  FORMATTING.lastIndex = 0;
  return FORMATTING.test(text);
}

const BOLD = "\x02";
const COLOUR = "\x03";
const HEX = "\x04";
const RESET = "\x0f";
const MONO = "\x11";
const REVERSE = "\x16";
const ITALIC = "\x1d";
const STRIKE = "\x1e";
const UNDERLINE = "\x1f";

type Toggle = "bold" | "italic" | "underline" | "strike" | "mono" | "reverse";

const TOGGLES: Record<string, Toggle> = {
  [BOLD]: "bold",
  [ITALIC]: "italic",
  [UNDERLINE]: "underline",
  [STRIKE]: "strike",
  [MONO]: "mono",
  [REVERSE]: "reverse",
};

/**
 * The line split into runs, each carrying what was in force where it started.
 *
 * `from` and the returned `end` thread the state across calls, because a colour
 * opened before a `**bold**` is still open after it and the two are separate
 * text nodes by the time this sees them.
 */
export function ircRuns(text: string, from: IrcStyle = PLAIN): { runs: IrcRun[]; end: IrcStyle } {
  const runs: IrcRun[] = [];
  let style = from;
  let plain = "";

  const flush = () => {
    if (plain === "") return;
    runs.push({ text: plain, style });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === COLOUR || ch === HEX) {
      const colour = ch === COLOUR ? readColour(text, i + 1) : readHex(text, i + 1);
      flush();
      style = { ...style, fg: colour.fg, bg: colour.bg };
      i = colour.end;
      continue;
    }

    const toggle = TOGGLES[ch];
    if (toggle !== undefined) {
      flush();
      style = { ...style, [toggle]: !style[toggle] };
      i++;
      continue;
    }

    if (ch === RESET) {
      flush();
      style = PLAIN;
      i++;
      continue;
    }

    plain += ch;
    i++;
  }

  flush();
  return { runs, end: style };
}

/**
 * The arguments to a `\x03`, which are optional in three different ways: no
 * digits at all resets both colours, digits alone set the foreground and leave
 * the background, and a comma counts only when a foreground claimed it. A line
 * opening `\x03,5` is a reset followed by the literal text `,5`, because the
 * comma in `4,8` belongs to the code and the comma in `,5` belongs to the
 * sentence.
 */
function readColour(
  text: string,
  at: number,
): { fg: number | null; bg: number | null; end: number } {
  const fg = readDigits(text, at);
  if (fg === null) return { fg: null, bg: null, end: at };

  if (text[fg.end] === ",") {
    const bg = readDigits(text, fg.end + 1);
    if (bg !== null) return { fg: paletteCode(fg.value), bg: paletteCode(bg.value), end: bg.end };
  }
  return { fg: paletteCode(fg.value), bg: null, end: fg.end };
}

function readDigits(text: string, at: number): { value: number; end: number } | null {
  let end = at;
  while (end < text.length && end - at < 2 && /\d/.test(text[end]!)) end++;
  if (end === at) return null;
  return { value: Number(text.slice(at, end)), end };
}

/** 99 is "whatever this client would have used", which is what null means here.
 * Anything past the palette is a code no client defines; it goes the same way
 * rather than resolving to an arbitrary neighbour. */
function paletteCode(value: number): number | null {
  return value <= 98 ? value : null;
}

/**
 * `\x04rrggbb`, which is not mIRC's own but travels with it. The sender picked
 * a value rather than an index, so there is no index to look up: the hue is
 * computed from the bytes and rounded to the nearest of the twelve, its
 * lightness to a row. What comes back is a code, so a hex colour and a numeric
 * one that mean the same thing draw the same.
 */
function readHex(
  text: string,
  at: number,
): { fg: number | null; bg: number | null; end: number } {
  const fg = readHexTriple(text, at);
  if (fg === null) return { fg: null, bg: null, end: at };

  if (text[fg.end] === ",") {
    const bg = readHexTriple(text, fg.end + 1);
    if (bg !== null) return { fg: fg.code, bg: bg.code, end: bg.end };
  }
  return { fg: fg.code, bg: null, end: fg.end };
}

function readHexTriple(text: string, at: number): { code: number; end: number } | null {
  const digits = text.slice(at, at + 6);
  if (!/^[\da-f]{6}$/i.test(digits)) return null;
  return { code: nearestCode(digits), end: at + 6 };
}

function nearestCode(hex: string): number {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const light = (high + low) / 2;

  // Too little colour left to name a hue, so it belongs on the grey ramp.
  if (high - low < 0.08) return 88 + Math.round(light * 10);

  let degrees: number;
  if (high === r) degrees = 60 * (((g - b) / (high - low)) % 6);
  else if (high === g) degrees = 60 * ((b - r) / (high - low) + 2);
  else degrees = 60 * ((r - g) / (high - low) + 4);
  if (degrees < 0) degrees += 360;

  const hue = Math.round(degrees / 30) % 12;
  // The wheel's six rows run darkest to lightest, so lightness picks the row.
  const row = Math.min(5, Math.max(0, Math.round(light * 5)));
  return 16 + row * 12 + hue;
}

/* The twelve hues of the extended wheel, in its own order: red at zero, then
   every thirty degrees. Eight are tokens outright and four are the mix of the
   tokens either side of them, which is what makes a twelve-hue wheel out of a
   palette that was never designed to be one. */
const HUES = [
  "var(--danger)",
  "color-mix(in oklab, var(--danger) 50%, var(--warning))",
  "var(--warning)",
  "color-mix(in oklab, var(--warning) 50%, var(--success))",
  "var(--success)",
  "color-mix(in oklab, var(--success) 50%, var(--nick-1))",
  "var(--nick-1)",
  "color-mix(in oklab, var(--nick-1) 50%, var(--accent))",
  "var(--accent)",
  "var(--nick-6)",
  "var(--nick-8)",
  "var(--nick-10)",
];

/** How much of the hue survives in each of the six rows, and what it is cut
 * with. The middle row is the token itself, which is why a bright classic red
 * and this theme's `--danger` are the same colour. */
const SHADES: ((hue: string) => string)[] = [
  (hue) => `color-mix(in oklab, ${hue} 38%, var(--surface-base))`,
  (hue) => `color-mix(in oklab, ${hue} 62%, var(--surface-base))`,
  (hue) => `color-mix(in oklab, ${hue} 82%, var(--surface-base))`,
  (hue) => hue,
  (hue) => `color-mix(in oklab, ${hue} 76%, var(--text-primary))`,
  (hue) => `color-mix(in oklab, ${hue} 54%, var(--text-primary))`,
];

/** The sixteen that came first, as a place on the same wheel or a grey level.
 * They are placed by hand against the values mIRC drew, because the originals
 * are not evenly spaced and no formula recovers them. */
const CLASSIC: ({ hue: number; shade: number } | { grey: number })[] = [
  { grey: 10 }, // white
  { grey: 0 }, // black
  { hue: 8, shade: 1 }, // navy
  { hue: 4, shade: 2 }, // green
  { hue: 0, shade: 3 }, // red
  { hue: 0, shade: 1 }, // maroon
  { hue: 10, shade: 2 }, // purple
  { hue: 1, shade: 3 }, // orange
  { hue: 2, shade: 3 }, // yellow
  { hue: 4, shade: 3 }, // light green
  { hue: 6, shade: 2 }, // teal
  { hue: 6, shade: 3 }, // cyan
  { hue: 8, shade: 3 }, // light blue
  { hue: 10, shade: 3 }, // pink
  { grey: 4 }, // grey
  { grey: 7 }, // light grey
];

/** The eleven-step ramp the greys land on. It stops short of the surface at the
 * dark end so that the darkest grey is dim rather than gone. */
function grey(level: number): string {
  return `color-mix(in oklab, var(--text-primary) ${30 + level * 7}%, var(--surface-base))`;
}

/** A colour code as something CSS will take, or null for a code no palette
 * defines. */
export function ircColour(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 98) return null;

  if (code < 16) {
    const slot = CLASSIC[code]!;
    return "grey" in slot
      ? grey(slot.grey)
      : SHADES[slot.shade]!(HUES[slot.hue]!);
  }
  if (code >= 88) return grey(code - 88);

  return SHADES[Math.floor((code - 16) / 12)]!(HUES[(code - 16) % 12]!);
}

export interface IrcCss {
  color?: string;
  background?: string;
  fontWeight?: number;
  fontStyle?: string;
  fontFamily?: string;
  textDecorationLine?: string;
}

/**
 * What a run is drawn with.
 *
 * Reverse video swaps the two colours and has to name both to do it: a run that
 * set neither is still reversible, so the defaults stand in and the surface
 * becomes the ink.
 */
export function ircCss(style: IrcStyle): IrcCss {
  const css: IrcCss = {};

  let fg = style.fg === null ? null : ircColour(style.fg);
  let bg = style.bg === null ? null : ircColour(style.bg);
  if (style.reverse) {
    [fg, bg] = [bg ?? "var(--surface-base)", fg ?? "var(--text-primary)"];
  }
  if (fg !== null) css.color = fg;
  if (bg !== null) css.background = bg;

  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = "italic";
  if (style.mono) css.fontFamily = "var(--font-mono)";

  const lines = [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
    .filter((line) => line !== "")
    .join(" ");
  if (lines !== "") css.textDecorationLine = lines;

  return css;
}

/**
 * The parsed line with its formatting codes turned into spans.
 *
 * Markdown is parsed first, on the raw text, because the codes are not
 * characters Markdown gives any meaning to: they pass through `parseSpans`
 * inside ordinary text spans and are picked up here. Doing it the other way
 * round would mean carrying offsets through a parser that consumes its own
 * delimiters, and there is nowhere to put them.
 *
 * State runs in document order across the whole message rather than per span,
 * so a colour opened before a `**bold**` is still open after it. That is what
 * `ircRuns` threads, and it is why this walks the tree with one cursor instead
 * of mapping over it.
 *
 * Code keeps its text and loses its codes. A fenced paste is data somebody is
 * showing, so colouring it would be the client editing what was pasted, and
 * printing the raw control bytes would be worse.
 */
export function applyIrcFormat(blocks: Block[]): Block[] {
  let style = PLAIN;

  const consume = (text: string): string => {
    const { runs, end } = ircRuns(text, style);
    style = end;
    return runs.map((run) => run.text).join("");
  };

  const walk = (spans: Span[]): Span[] =>
    spans.flatMap((span): Span[] => {
      switch (span.type) {
        case "text": {
          const { runs, end } = ircRuns(span.text, style);
          style = end;
          return runs.map((run) =>
            isPlain(run.style)
              ? { type: "text", text: run.text }
              : { type: "irc", style: run.style, text: run.text },
          );
        }
        case "code":
          return [{ type: "code", text: consume(span.text) }];
        case "strong":
        case "em":
        case "strike":
        case "spoiler":
          return [{ ...span, spans: walk(span.spans) }];
        default:
          return [span];
      }
    });

  return blocks.map((block): Block => {
    switch (block.type) {
      case "code":
        return { ...block, text: consume(block.text) };
      case "list":
        return { ...block, items: block.items.map(walk) };
      default:
        return { ...block, spans: walk(block.spans) };
    }
  });
}
