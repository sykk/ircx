/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.presentation";

export type ClockFormat = "24h" | "24h-seconds" | "12h" | "12h-bare" | "off";

/** Which side of the nickname the clock is set on. */
export type ClockSide = "left" | "right";

/**
 * What the timeline draws, as against what colour it draws it in.
 *
 * These are settings rather than tokens, and so not part of a theme.
 * src/lib/theme/overrides.ts gates a theme to the names in `REQUIRED_TOKENS`
 * exactly so a theme cannot restyle a component, and each of the settings below
 * changes what a component puts on the screen. They sit beside the density for
 * the reason the density sits apart from the theme: changing how the
 * conversation is set should not change its palette.
 */
export interface Presentation {
  /** The rule at the rail. It carries grouping and its hue names the group's
   * opener, so nothing else on the row says which conversation a block belongs
   * to — the two marks a mention keeps without it are the line above the run
   * and the tint on the row. */
  spine: boolean;
  clock: ClockFormat;
  /** The head of a run states who and when, and this is the order it states
   * them in. Either way the prose beneath starts under the name: a clock in
   * front opens a column of its own, and the lines of the run are set beside it
   * rather than under it, as a client with a timestamp column set them. */
  clockSide: ClockSide;
  /** `<nick>` at the head of a run, as clients that printed the name beside
   * every line wrote it. */
  nickBrackets: boolean;
  /** Who said it and when, in front of every line, instead of once above the
   * run. The prefix sits in the flow of the prose rather than in a column of
   * its own — a column sized to the widest name in the block is what the head
   * of a run replaced, and it moved the left edge of the prose every time a
   * longer name spoke. */
  nickEveryLine: boolean;
}

export const DEFAULT_PRESENTATION: Presentation = {
  spine: true,
  clock: "24h",
  clockSide: "right",
  nickBrackets: false,
  nickEveryLine: false,
};

/**
 * The clock formats offered, what each one prints, and how wide it can print.
 *
 * The example is written out rather than computed because `formatClock` is in
 * the timeline, which is above this module; presentation.test.ts is below both
 * and asserts every example against it, so the two cannot drift.
 *
 * `columns` is the widest the format can be, in characters of the mono face it
 * is set in. It is not the example's length: the 12-hour formats do not pad the
 * hour, so the example prints a one-digit hour and half the day prints two. A
 * clock in front of the name opens a column the prose lines up behind, and that
 * column has to be the same width in every block or the left edge of the
 * conversation moves whenever the hour rolls over.
 */
export const CLOCK_FORMATS: readonly {
  id: ClockFormat;
  name: string;
  /** Null for the format that prints nothing. */
  example: string | null;
  /** Null where there is nothing to make room for. */
  columns: number | null;
}[] = [
  { id: "24h", name: "24-hour", example: "14:32", columns: 5 },
  { id: "24h-seconds", name: "24-hour with seconds", example: "14:32:07", columns: 8 },
  { id: "12h", name: "12-hour", example: "2:32 PM", columns: 8 },
  { id: "12h-bare", name: "12-hour, no suffix", example: "2:32", columns: 5 },
  { id: "off", name: "Off", example: null, columns: null },
];

export const CLOCK_SIDES: readonly { id: ClockSide; name: string }[] = [
  { id: "left", name: "Before the nickname" },
  { id: "right", name: "After the nickname" },
];

/**
 * A usable setting from anything at all, field by field.
 *
 * localStorage is a text file the user can edit, so what comes back is
 * untrusted input rather than what was written. Each field falls back on its
 * own: a blob with one unrecognised value keeps its neighbours rather than
 * throwing away a whole setting because part of it was mistyped.
 */
export function sanitisePresentation(raw: unknown): Presentation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_PRESENTATION;
  const held = raw as Record<string, unknown>;
  return {
    spine: typeof held.spine === "boolean" ? held.spine : DEFAULT_PRESENTATION.spine,
    clock: CLOCK_FORMATS.some((format) => format.id === held.clock)
      ? (held.clock as ClockFormat)
      : DEFAULT_PRESENTATION.clock,
    clockSide: CLOCK_SIDES.some((side) => side.id === held.clockSide)
      ? (held.clockSide as ClockSide)
      : DEFAULT_PRESENTATION.clockSide,
    nickBrackets:
      typeof held.nickBrackets === "boolean"
        ? held.nickBrackets
        : DEFAULT_PRESENTATION.nickBrackets,
    nickEveryLine:
      typeof held.nickEveryLine === "boolean"
        ? held.nickEveryLine
        : DEFAULT_PRESENTATION.nickEveryLine,
  };
}

export function storedPresentation(): Presentation {
  try {
    const held = localStorage.getItem(STORAGE_KEY);
    return held === null ? DEFAULT_PRESENTATION : sanitisePresentation(JSON.parse(held));
  } catch {
    return DEFAULT_PRESENTATION;
  }
}

export function storePresentation(next: Presentation): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* A window that cannot remember the setting still renders at it. */
  }
}
