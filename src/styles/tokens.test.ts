import { readFileSync, readdirSync } from "node:fs";

// readability/READABILITY.md finding 1: an unconstrained nick palette collides
// with the security and connection colours, and a nick rendered in the colour
// that means "error" is a lie the user cannot see. These assert the constraint
// rather than the specific values, so retuning a hue stays cheap and stepping
// outside the band does not.
//
// Every theme shipped is held to it, not just the two that were here first: a
// theme is the one thing that can put a nick back on top of --danger.

// Relative to the vitest root, which is the project root.
const THEMES_DIR = "src/styles/themes";

const COOL_MIN = 180;
const COOL_MAX = 350;
const AA_BODY = 4.5;

/** A disabled control is exempt from the AA floor, but not from being seen.
 * Below this the accent fades into its own surface and the control reads as
 * missing rather than as present and unavailable. */
const DISABLED_FLOOR = 2.5;

/** The surfaces a nickname can be drawn on. Contrast is checked against all of
 * them, so a hue only has to clear the worst one. */
const SURFACES = [
  "surface-base",
  "surface-sidebar",
  "surface-raised",
  "surface-hover",
  "surface-active",
];

const THEMES = readdirSync(THEMES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    id: entry.name,
    css: readFileSync(`${THEMES_DIR}/${entry.name}/theme.css`, "utf8"),
  }));

function readVars(css: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(
    /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g,
  )) {
    if (name!.startsWith(prefix)) out[name!] = value!;
  }
  return out;
}

function readNumber(css: string, name: string): number {
  const match = new RegExp(`--${name}:\\s*([0-9.]+)\\s*;`).exec(css);
  if (!match) throw new Error(`missing --${name}`);
  return Number(match[1]);
}

function channels(hex: string): [number, number, number] {
  const n = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sextant =
    max === r ? (((g - b) / delta) % 6) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return ((sextant * 60) % 360 + 360) % 360;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The colour the compositor ends up painting for `hex` drawn at `alpha` over
 * `over` — an opacity is only ever seen through the surface behind it. */
function flatten(hex: string, over: string, alpha: number): string {
  const front = channels(hex);
  const back = channels(over);
  return `#${front
    .map((c, i) => Math.round((c * alpha + back[i]! * (1 - alpha)) * 255))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

it("ships the two built-in themes", () => {
  expect(THEMES.map((theme) => theme.id)).toEqual(
    expect.arrayContaining(["ircx-dark", "ircx-light"]),
  );
});

describe.each(THEMES)("$id nick palette", ({ css }) => {
  const nicks = readVars(css, "nick-");
  const all = readVars(css, "");
  const surfaceValues = SURFACES.map((surface) => {
    const value = all[surface];
    if (!value) throw new Error(`missing --${surface}`);
    return value;
  });

  it("defines all ten entries", () => {
    expect(Object.keys(nicks)).toHaveLength(10);
  });

  it.each(Object.entries(nicks))("%s sits in the cool band", (_name, value) => {
    const h = hue(value);
    expect(h).toBeGreaterThanOrEqual(COOL_MIN);
    expect(h).toBeLessThanOrEqual(COOL_MAX);
  });

  it.each(Object.entries(nicks))("%s clears AA on every surface", (_name, value) => {
    for (const surface of surfaceValues) {
      expect(contrast(value, surface)).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("keeps every nick clear of the status colours", () => {
    const reserved = ["state-connected", "state-connecting", "state-error", "danger", "success", "warning"]
      .map((n) => all[n])
      .filter((v): v is string => Boolean(v));

    for (const [name, value] of Object.entries(nicks)) {
      for (const status of reserved) {
        const apart = Math.abs(hue(value) - hue(status));
        expect(Math.min(apart, 360 - apart), `--${name} vs ${status}`).toBeGreaterThan(20);
      }
    }
  });
});

// The disabled fraction is a token because a ratio tuned against one palette is
// wrong against the other: 0.4 read as quiet on the dark surface and as empty
// on the light one. The rule that produced each theme's value is the floor
// below, not a preference, so a theme that retunes it has something to check
// against.
describe.each(THEMES)("$id disabled controls", ({ css }) => {
  const all = readVars(css, "");
  const opacity = readNumber(css, "disabled-opacity");

  /** Where a disabled control actually sits: the onboarding button on the base
   * surface, the composer's send affordance on the raised one. */
  it.each(["surface-base", "surface-raised"])("stay visible on --%s", (surface) => {
    const accent = all["accent"];
    const behind = all[surface];
    if (!accent || !behind) throw new Error(`missing --accent or --${surface}`);

    expect(contrast(flatten(accent, behind, opacity), behind)).toBeGreaterThanOrEqual(
      DISABLED_FLOOR,
    );
  });
});
