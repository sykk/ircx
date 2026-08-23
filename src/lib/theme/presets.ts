import { CLASSIC_THEME_ID, FALLBACK_THEME_ID } from "./load";
import type { Presentation } from "./presentation";
import type { Typography } from "./typography";

/**
 * A palette and the layout that goes with it, applied together.
 *
 * A theme is a set of token values and cannot state anything else — that is the
 * contract src/lib/theme/overrides.ts enforces, and widening it would mean
 * every theme on disk could restyle a component. But a look is more than a
 * palette: the classic one is black surfaces *and* no spine *and* `<nick>` at
 * the head of a run, and asking somebody to find three settings after choosing
 * a theme is asking them to guess what the theme was for.
 *
 * So a preset is the bundle, and it lives here rather than in a theme file. It
 * writes what a person could have written by hand, and leaves each of those
 * settings theirs to change afterwards — applying one is a starting point, not
 * a mode the window is now in.
 */
export interface Preset {
  id: string;
  name: string;
  detail: string;
  theme: string;
  /** Every timeline setting but one. Whether the name is stated in front of
   * every line stays where the reader left it: it decides how much of the
   * window a conversation takes rather than what it looks like, and somebody
   * who reads a channel that way reads every look that way. */
  presentation: Omit<
    Presentation,
    | "nickEveryLine"
    | "compactSingletons"
    | "messageSize"
    | "measure"
    | "nickColors"
    | "clockEmphasis"
  >;
  /** The faces only. A preset does not touch the window scale: that is an
   * accessibility setting somebody chose for their eyes, and no look is worth
   * resizing the window somebody else set. */
  faces: Pick<Typography, "prose" | "mono">;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "classic",
    name: "Classic IRC",
    detail: "Black ground, no spine, the time and then <nick> at the head of a run",
    theme: CLASSIC_THEME_ID,
    presentation: {
      spine: false,
      clock: "24h-seconds",
      clockSide: "left",
      nickBrackets: true,
      align: "rail",
    },
    faces: { prose: "mono", mono: "courier" },
  },
  {
    id: "ircx",
    name: "ircx",
    detail: "The dark theme with ircx's default timeline layout",
    theme: FALLBACK_THEME_ID,
    presentation: {
      spine: true,
      clock: "24h",
      clockSide: "right",
      nickBrackets: false,
      align: "center",
    },
    faces: { prose: "inter", mono: "jetbrains" },
  },
];
