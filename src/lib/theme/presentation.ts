/** Mirrors the theme's own key: a preference the backend has no reason to know
 * about lives next to the other window state. */
const STORAGE_KEY = "ircx.presentation";

export type ClockFormat = "24h" | "24h-seconds" | "12h" | "off";

/**
 * What the timeline draws, as against what colour it draws it in.
 *
 * These are settings rather than tokens, and so not part of a theme.
 * src/lib/theme/overrides.ts gates a theme to the names in `REQUIRED_TOKENS`
 * exactly so a theme cannot restyle a component, and each of the three below
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
  /** `<nick>` at the head of a run, as clients that printed the name beside
   * every line wrote it. */
  nickBrackets: boolean;
}

export const DEFAULT_PRESENTATION: Presentation = {
  spine: true,
  clock: "24h",
  nickBrackets: false,
};

/**
 * The clock formats offered and what each one prints.
 *
 * The example is written out rather than computed because `formatClock` is in
 * the timeline, which is above this module; presentation.test.ts is below both
 * and asserts every example against it, so the two cannot drift.
 */
export const CLOCK_FORMATS: readonly {
  id: ClockFormat;
  name: string;
  /** Null for the format that prints nothing. */
  example: string | null;
}[] = [
  { id: "24h", name: "24-hour", example: "14:32" },
  { id: "24h-seconds", name: "24-hour with seconds", example: "14:32:07" },
  { id: "12h", name: "12-hour", example: "2:32 PM" },
  { id: "off", name: "Off", example: null },
];

/**
 * A usable setting from anything at all, field by field.
 *
 * localStorage is a text file the user can edit, so what comes back is
 * untrusted input rather than what was written. Each field falls back on its
 * own: a blob with one unrecognised value keeps the other two rather than
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
    nickBrackets:
      typeof held.nickBrackets === "boolean"
        ? held.nickBrackets
        : DEFAULT_PRESENTATION.nickBrackets,
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
