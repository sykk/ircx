import { parseStylesheet } from "./parse";

import darkStylesheet from "@/styles/themes/ircx-dark/theme.css?raw";

/** Every custom property the UI reads, taken from the theme that defines them
 * all. Deriving the list rather than writing it down is what keeps a token
 * added to the dark theme from being optional everywhere else. */
export const REQUIRED_TOKENS: readonly string[] = Object.keys(
  parseStylesheet(darkStylesheet).tokens,
).sort();

export type TokenKind = "color" | "length" | "number" | "shadow" | "css-color" | "keyword";

export interface TokenSpec {
  group: string;
  kind: TokenKind;
  /** The whole set a `keyword` token may hold, because there is no editor for
   * a word that only three values are legal for. */
  options?: readonly string[];
}

/** The order the editor lays its sections out in: the palette first, because
 * that is what someone opening it came to change, and the measurements last. */
export const TOKEN_GROUPS: readonly string[] = [
  "Surfaces",
  "Borders",
  "Text",
  "Accent",
  "Status",
  "Connection state",
  "Badges",
  "Unread & mention",
  "Nick palette",
  "Radii",
  "Timeline density",
  "Timeline layout",
  "Focus ring",
  "Scrollbar",
  "Depth",
];

/* This one is written out by hand while REQUIRED_TOKENS above is derived, and
 * the difference is what each list is for. A stylesheet states a token's value
 * and nothing else: it cannot say that --divider-unread and --mention-bg are
 * one section while --danger belongs with the other status colours, or that
 * --disabled-opacity takes a fraction rather than a length, because both are
 * editorial judgements about how the thing should be presented rather than
 * facts about the file. REQUIRED_TOKENS stays the contract a theme is held to;
 * this is only how the editor arranges the same tokens for a person. A token
 * added to the dark theme and forgotten here is therefore missing from the
 * editor, not from the theme, and no theme stops loading over it. */
export const TOKEN_CATALOGUE: Readonly<Record<string, TokenSpec>> = {
  "--surface-base": { group: "Surfaces", kind: "color" },
  "--surface-sidebar": { group: "Surfaces", kind: "color" },
  "--surface-raised": { group: "Surfaces", kind: "color" },
  "--surface-overlay": { group: "Surfaces", kind: "color" },
  "--surface-hover": { group: "Surfaces", kind: "color" },
  "--surface-active": { group: "Surfaces", kind: "color" },

  "--border-subtle": { group: "Borders", kind: "color" },
  "--border-default": { group: "Borders", kind: "color" },
  "--border-strong": { group: "Borders", kind: "color" },

  "--text-primary": { group: "Text", kind: "color" },
  "--text-secondary": { group: "Text", kind: "color" },
  "--text-muted": { group: "Text", kind: "color" },
  "--text-faint": { group: "Text", kind: "color" },
  "--text-inverse": { group: "Text", kind: "color" },
  /* Sits with the text because that is what it is solved against: the fraction
   * is the one that keeps --text-primary readable faded over its surface, so
   * retuning the text colour is what makes this value wrong. */
  "--pending-opacity": { group: "Text", kind: "number" },
  "--font-smoothing": {
    group: "Text",
    kind: "keyword",
    options: ["antialiased", "auto", "subpixel-antialiased"],
  },

  "--accent": { group: "Accent", kind: "color" },
  "--accent-hover": { group: "Accent", kind: "color" },
  "--accent-muted": { group: "Accent", kind: "color" },
  /* Sits with the accent because that is what it is solved against: the
   * fraction is the one that keeps --accent faded over its surface visible,
   * so retuning the accent is what makes this value wrong. */
  "--disabled-opacity": { group: "Accent", kind: "number" },

  "--success": { group: "Status", kind: "color" },
  "--warning": { group: "Status", kind: "color" },
  "--danger": { group: "Status", kind: "color" },

  "--state-connected": { group: "Connection state", kind: "color" },
  "--state-connecting": { group: "Connection state", kind: "color" },
  "--state-disconnected": { group: "Connection state", kind: "color" },
  "--state-error": { group: "Connection state", kind: "color" },

  "--badge-bg": { group: "Badges", kind: "color" },
  "--badge-text": { group: "Badges", kind: "color" },
  "--badge-highlight-bg": { group: "Badges", kind: "color" },
  "--badge-highlight-text": { group: "Badges", kind: "color" },

  "--divider-unread": { group: "Unread & mention", kind: "color" },
  "--mention-bg": { group: "Unread & mention", kind: "color" },

  "--nick-1": { group: "Nick palette", kind: "color" },
  "--nick-2": { group: "Nick palette", kind: "color" },
  "--nick-3": { group: "Nick palette", kind: "color" },
  "--nick-4": { group: "Nick palette", kind: "color" },
  "--nick-5": { group: "Nick palette", kind: "color" },
  "--nick-6": { group: "Nick palette", kind: "color" },
  "--nick-7": { group: "Nick palette", kind: "color" },
  "--nick-8": { group: "Nick palette", kind: "color" },
  "--nick-9": { group: "Nick palette", kind: "color" },
  "--nick-10": { group: "Nick palette", kind: "color" },

  "--radius-sm": { group: "Radii", kind: "length" },
  "--radius-md": { group: "Radii", kind: "length" },
  "--radius-lg": { group: "Radii", kind: "length" },

  /* Exactly the three a density states, kept in their own section because an
   * edit to one of them is the edit compact and read supersede. */
  "--timeline-row-pad-y": { group: "Timeline density", kind: "length" },
  "--timeline-block-gap": { group: "Timeline density", kind: "length" },
  "--timeline-body-leading": { group: "Timeline density", kind: "number" },

  "--timeline-rail-pad": { group: "Timeline layout", kind: "length" },
  "--timeline-spine-width": { group: "Timeline layout", kind: "length" },
  "--timeline-spine-gap": { group: "Timeline layout", kind: "length" },
  "--timeline-rule-gap": { group: "Timeline layout", kind: "length" },
  "--timeline-measure": { group: "Timeline layout", kind: "length" },
  "--timeline-actions-col": { group: "Timeline layout", kind: "length" },
  "--timeline-actions-gap": { group: "Timeline layout", kind: "length" },
  "--timeline-quote-width": { group: "Timeline layout", kind: "length" },

  "--focus-ring-width": { group: "Focus ring", kind: "length" },
  "--focus-ring-offset": { group: "Focus ring", kind: "length" },

  "--scrollbar-size": { group: "Scrollbar", kind: "length" },
  "--scrollbar-thumb-inset": { group: "Scrollbar", kind: "length" },

  "--scrim": { group: "Depth", kind: "css-color" },
  "--shadow-overlay": { group: "Depth", kind: "shadow" },
};
