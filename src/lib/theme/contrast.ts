/* The colour arithmetic the token contract is argued in: WCAG relative
 * luminance, the ratio built on it, and the hue band the nick palette is held
 * to. It lives here rather than in the test that first wrote it because the
 * appearance editor has to warn about the same values src/styles/tokens.test.ts
 * fails on — a colour that would break the build should not look fine while it
 * is being typed. */

export const COOL_MIN = 180;
export const COOL_MAX = 350;
export const AA_BODY = 4.5;

/** A disabled control is exempt from the AA floor, but not from being seen.
 * Below this the accent fades into its own surface and the control reads as
 * missing rather than as present and unavailable. */
export const DISABLED_FLOOR = 2.5;

/** The surfaces a nickname can be drawn on. Contrast is checked against all of
 * them, so a hue only has to clear the worst one. */
export const SURFACES: readonly string[] = [
  "surface-base",
  "surface-sidebar",
  "surface-raised",
  "surface-hover",
  "surface-active",
];

export function channels(hex: string): [number, number, number] {
  const n = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

export function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sextant =
    max === r ? (((g - b) / delta) % 6) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return ((sextant * 60) % 360 + 360) % 360;
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The colour the compositor ends up painting for `hex` drawn at `alpha` over
 * `over` — an opacity is only ever seen through the surface behind it. */
export function flatten(hex: string, over: string, alpha: number): string {
  const front = channels(hex);
  const back = channels(over);
  return `#${front
    .map((c, i) => Math.round((c * alpha + back[i]! * (1 - alpha)) * 255))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `#rrggbb` for any hex the CSS parser would take, and null for everything
 * else.
 *
 * Every function above assumes exactly six digits: given `#fff`, `channels`
 * returns NaN, `contrast` returns NaN with it, and every `>= 4.5` comparison
 * then reads false without anyone deciding it should. A warning system that
 * silently stops warning is worse than one that admits it cannot tell, so a
 * value this does not recognise — a colour name, `rgb()`, half a hex code
 * someone is still typing — comes back as null and the caller shows nothing
 * rather than something wrong.
 *
 * The alpha of an eight-digit hex is dropped rather than honoured: what that
 * colour actually looks like depends on the surface behind it, which is
 * `flatten`'s question, not this one's.
 */
export function toHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (!HEX.test(hex)) return null;
  const digits = hex.slice(1);
  if (digits.length === 3) {
    return `#${[...digits].map((digit) => digit + digit).join("")}`;
  }
  return `#${digits.slice(0, 6)}`;
}
